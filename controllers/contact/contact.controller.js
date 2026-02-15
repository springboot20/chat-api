import mongoose from 'mongoose';
import { ContactModel, userModel } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { StatusCodes } from 'http-status-codes';

export const getSuggestedFriends = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // 1. Get IDs of people already in user's contacts
  const myContacts = await ContactModel.find({ owner: userId }).select('contact');
  const contactIds = myContacts.map((c) => c.contact);

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

  return new ApiResponse(200, 'Suggestions fetched successfully', suggestedUsers);
});

export const getBlockedContacts = asyncHandler(async (req, res) => {
  const blockedList = await ContactModel.find({
    owner: req.user._id,
    isBlocked: true,
  }).populate('contact', 'username avatar email');

  return new ApiResponse(StatusCodes.OK, 'Blocked contacts fetched', blockedList);
});

export const getMyContacts = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;

  const parsedPage = Math.min(1, parseInt(page) || 1);
  const parsedLimit = Math.min(1, parseInt(limit) || 10);
  const skip = (parsedPage - 1) * parsedLimit;

  const contacts = await ContactModel.find({ owner: req.user._id, isBlocked: false })
    .populate('contact', 'username avatar email')
    .skip(skip)
    .limit(parsedLimit)
    .sort('-createdAt');

  const total = contacts.length;
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

  return new ApiResponse(200, 'Contacts fetched successfully', data);
});

export const addToContact = asyncHandler(async (req, res) => {
  const { category, contactId } = req.body;
  const userId = req.user._id;

  const existingContact = await ContactModel.findOne({
    owner: userId,
    contact: new mongoose.Types.ObjectId(contactId),
  });

  if (existingContact) return new ApiError(StatusCodes.CONFLICT, 'Already in Contact');

  const createdContact = await ContactModel.create({
    owner: userId,
    contact: contactId,
    category,
  });

  return new ApiResponse(StatusCodes.CREATED, 'Contact added', createdContact);
});

export const toggleBlockContact = asyncHandler(async (req, res) => {
  const { contactId } = req.params;
  const userId = req.user._id;

  const contact = await ContactModel.findOne({
    owner: userId,
    contact: contactId,
  });

  if (!contact) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Contact not found in your list');
  }

  // Toggle the blocked status
  contact.isBlocked = !contact.isBlocked;
  await contact.save();

  return new ApiResponse(
    StatusCodes.OK,
    `User ${contact.isBlocked ? 'blocked' : 'unblocked'} successfully`,
    contact,
  );
});
