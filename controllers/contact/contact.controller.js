import mongoose from "mongoose";
import { ContactModel, userModel } from "../../models/index.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { StatusCodes } from "http-status-codes";

export const getSuggestedFriends = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // 1. Get IDs of people already in user's contacts
  const myContacts = await ContactModel.find({ owner: userId }).select(
    "contactsList",
  );
  const contactIds = myContacts?.contactsList.map((c) => c.contact) || [];

  // 2. Find users who are NOT me and NOT already my contacts
  const suggestedUsers = await userModel.aggregate([
    {
      $match: {
        _id: { $nin: [...contactIds, userId] },
      },
    },

    {
      $project: {
        username: 1,
        avatar: 1,
        email: 1,
      },
    },
  ]);

  return new ApiResponse(
    200,
    "Suggestions fetched successfully",
    suggestedUsers,
  );
});

export const getBlockedContacts = asyncHandler(async (req, res) => {
  const blockedList = await ContactModel.aggregate([
    {
      $match: {
        owner: req.user._id,
      },
    },
    { $unwind: "contactsList" },
    {
      $match: {
        "contactsList.isBlocked": true,
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "contactsList.contact",
        foreignField: "_id",
        as: "contactsList.contact",
        pipeline: [
          {
            $project: {
              username: 1,
              avatar: 1,
              email: 1,
            },
          },
        ],
      },
    },
    {
      $addFields: {
        "contactsList.contact": {
          $first: "$contactsList.contact",
        },
      },
    },
    {
      $replaceRoot: {
        newRoot: "$contactsList",
      },
    },
  ]);

  return new ApiResponse(
    StatusCodes.OK,
    "Blocked contacts fetched",
    blockedList,
  );
});

export const getMyContacts = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;

  const userId = req.user._id;
  const parsedPage = Math.max(1, parseInt(page) || 1);
  const parsedLimit = Math.max(1, parseInt(limit) || 10);
  const skip = (parsedPage - 1) * parsedLimit;

  const basePipeline = [
    {
      $match: {
        owner: userId,
      },
    },
    { $unwind: "$contactsList" },
    {
      $match: {
        "contactsList.isBlocked": false,
      },
    },
  ];

  const [contacts, totalResult] = await Promise.all([
    ContactModel.aggregate([
      ...basePipeline,
      {
        $sort: {
          "contactsList.createdAt": -1,
        },
      },
      { $skip: skip },
      { $limit: parsedLimit },
      {
        $lookup: {
          from: "users",
          foreignField: "_id",
          localField: "contactsList.contact",
          as: "contactsList.contact",
          pipeline: [
            {
              $project: {
                username: 1,
                email: 1,
                avatar: 1,
              },
            },
          ],
        },
      },
      {
        $addFields: {
          "contactsList.contact": {
            $first: "$contactsList.contact",
          },
        },
      },
      {
        $replaceRoot: {
          newRoot: "$contactsList",
        },
      },
    ]),
    ContactModel.aggregate([
      ...basePipeline,
      {
        $count: "total",
      },
    ]),
  ]);

  const total = totalResult[0]?.total || 0;
  const totalPages = Math.ceil(total / parsedLimit);
  const hasMore = parsedPage < totalPages;

  const data = {
    contacts,
    pagination: {
      total,
      itemsPerPage: parsedLimit,
      totalPages,
      hasMore,
      page: parsedPage,
    },
  };

  return new ApiResponse(200, "Contacts fetched successfully", data);
});

export const addToContact = asyncHandler(async (req, res) => {
  const { category, contactId } = req.body;
  const userId = req.user._id;

  const contactObjectId = new mongoose.Types.ObjectId(contactId);
  const ownerDoc = await ContactModel.findOne({ owner: userId });

  const existingContactEntry = ownerDoc?.contactsList?.find(
    (contact) => contact.contact.toString() === contactId.toString(),
  );

  if (existingContactEntry) {
    if (!existingContactEntry.isBlocked)
      throw new ApiError(StatusCodes.CONFLICT, "Already in Contact");

    existingContactEntry.isBlocked = false;
    existingContactEntry.category = category || existingContactEntry.category;
    await ownerDoc.save();

    return new ApiResponse(StatusCodes.OK, "Contact re-added", existingContactEntry);
  }

  const updatedDoc = await ContactModel.findOneAndUpdate(
    { owner: userId },
    {
      $push: {
        contactsList: {
          contact: contactObjectId,
          category,
        },
      },
    },
    { new: true, upsert: true },
  );

  const createdContact =
    updatedDoc.contactsList[updatedDoc.contactsList.length - 1];

  return new ApiResponse(StatusCodes.CREATED, "Contact added", createdContact);
});

export const toggleBlockContact = asyncHandler(async (req, res) => {
  const { contactId } = req.params;
  const userId = req.user._id;

  const ownerDoc = await ContactModel.findOne({ owner: userId });

  if (!ownerDoc) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Contact not found in your list");
  }

  const entry = ownerDoc.contactsList.find(
    (c) => c.contact.toString() === contactId,
  );

  if (!entry) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Contact not found in your list");
  }

  // Toggle the blocked status
  entry.isBlocked = !entry.isBlocked;
  await ownerDoc.save();

  return new ApiResponse(
    StatusCodes.OK,
    `User ${entry.isBlocked ? "blocked" : "unblocked"} successfully`,
    entry,
  );
});
