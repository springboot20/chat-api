import { StatusCodes } from "http-status-codes";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { chatModel, messageModel, userModel } from "../../models/index.js";
import { removeLocalFile } from "../../helper.js";
import { withTransaction } from "../../middlewares/mongoose.middleware.js";
import mongoose from "mongoose";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { mountNewChatEvent } from "../../socketIo/socket.js";
import { SocketEventEnum } from "../../constants/constants.js";

/**
 * @description Utility function which returns the pipeline stages to structure the chat schema with common lookups
 * @returns {mongoose.PipelineStage[]}
 */

const pipelineAggregation = () => {
  return [
    {
      $lookup: {
        from: "users",
        foreignField: "_id",
        localField: "participants",
        as: "participants",
        pipeline: [
          {
            $project: {
              password: 0,
              refreshToken: 0,
              forgotPasswordToken: 0,
              forgotPasswordExpiry: 0,
              emailVerificationToken: 0,
              emailVerificationExpiry: 0,
            },
          },
        ],
      },
    },
    {
      // lookup for the group chats
      $lookup: {
        from: "chatmessages",
        foreignField: "_id",
        localField: "lastMessage",
        as: "lastMessage",
        pipeline: [
          {
            // get details of the sender
            $lookup: {
              from: "users",
              foreignField: "_id",
              localField: "sender",
              as: "sender",
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
              sender: { $first: "$sender" },
            },
          },
        ],
      },
    },
    {
      $addFields: {
        lastMessage: { $first: "$lastMessage" },
      },
    },
  ];
};

const deleteCascadeMessages = async (chatId) => {
  const chatMessages = await messageModel.find({
    chat: new mongoose.Types.ObjectId(chatId),
  });

  let attachments = [];

  attachments = attachments.concat(
    ...chatMessages.map((msg) => {
      return msg.attachments;
    })
  );

  attachments.forEach((attachment) => {
    removeLocalFile(attachment.localPath);
  });

  await messageModel.deleteMany({ chat: new mongoose.Types.ObjectId(chatId) });
};

export const GetOrCreateChatMessage = asyncHandler(async (req, res) => {
  const { receiverId } = req.params;

  console.log(req);

  const receiver = await userModel.findOne({ _id: new mongoose.Types.ObjectId(receiverId) });
  console.log(receiver);

  if (!receiver) throw new ApiError(StatusCodes.NOT_FOUND, "Receiver does not exists");

  if (req.user._id.toString() === receiver._id.toString())
    throw new ApiError(StatusCodes.BAD_REQUEST, "message cannot be send to yourself");

  const chat = await chatModel.aggregate([
    {
      $match: {
        isGroupChat: false,
        $and: [
          {
            participants: {
              $elemMatch: {
                $eq: req.user._id,
              },
            },
          },
          {
            participants: {
              $elemMatch: {
                $eq: new mongoose.Types.ObjectId(receiver?._id),
              },
            },
          },
        ],
      },
    },
    ...pipelineAggregation(),
  ]);

  if (chat.length) {
    return new ApiResponse(StatusCodes.OK, "chat retrieved successfully", chat[0]);
  }

  const newChatMessageInstanceWithSomeone = await chatModel.create({
    name: "two user chat",
    isGroupChat: false,
    participants: [req.user._id, new mongoose.Types.ObjectId(receiverId)],
    admin: req.user._id,
  });

  console.log(newChatMessageInstanceWithSomeone);

  const createdChat = await chatModel.aggregate([
    {
      $match: {
        _id: newChatMessageInstanceWithSomeone._id,
      },
    },
    ...pipelineAggregation(),
  ]);

  const chatPayload = createdChat[0];

  if (!chatPayload) throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Internal server error");

  console.log(chatPayload, "line 165");

  chatPayload?.participants?.forEach((participant) => {
    if (req.user._id.toString() === participant._id.toString()) return;

    mountNewChatEvent(req, SocketEventEnum.NEW_CHAT_EVENT, chatPayload, participant._id.toString());
  });

  return new ApiResponse(StatusCodes.OK, "Chat retrieved successfully", chatPayload);
});

export const createGroupChat = asyncHandler(async (req, res) => {
  const { name, participants } = req.body;

  console.log(req.body);

  if (participants?.includes(req.user._id)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Participants payload should not contain the group creator"
    );
  }

  const groupChatMembers = [...new Set([...participants, req.user._id.toString()])];

  if (groupChatMembers.length < 3) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Seems like there is a duplicate members added");
  }

  const newGroupChatMessage = await chatModel.create({
    name: name ?? "group chat",
    admin: req.user._id,
    participants: groupChatMembers,
    isGroupChat: true,
  });

  const createdGroupChat = await chatModel.aggregate([
    {
      $match: {
        _id: newGroupChatMessage._id,
      },
    },
  ]);

  const groupChatPayload = createdGroupChat[0];

  console.log(groupChatPayload);

  groupChatPayload?.participants?.forEach((participant) => {
    if (req.user._id.toString() === participant._id.toString()) return;
    mountNewChatEvent(
      req,
      SocketEventEnum.NEW_CHAT_EVENT,
      groupChatPayload,
      participant._id.toString()
    );
  });

  return new ApiResponse(StatusCodes.OK, "Chat retrieved successfully", groupChatPayload);
});

export const changeGroupName = asyncHandler(async (req, res) => {
  const { name } = req.body;
  const { chatId } = req.params;

  const groupChat = await chatModel.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!groupChat) throw new ApiError(StatusCodes.NOT_FOUND, "Chat does not exists");
  if (groupChat._id.toString() === req.user._id.toString()) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Not an Admin");
  }

  const updatedChat = await chatModel.findByIdAndUpdate(
    chatId,
    {
      $set: {
        name: name,
      },
    },
    { new: true }
  );

  await updatedChat.save();

  const chat = await chatModel.aggregate([
    {
      $match: {
        _id: updatedChat._id,
        isGroupChat: true,
      },
    },
    ...pipelineAggregation(),
  ]);

  const updatedChatPayload = chat[0];

  updatedChatPayload.participants.forEach((participant) => {
    mountNewChatEvent(
      req,
      SocketEventEnum.NEW_GROUP_NAME,
      updatedChatPayload,
      participant._id.toString()
    );
  });

  return new ApiResponse(StatusCodes.OK, "Group chat name updated", chat[0]);
});

export const getGroupChatDetails = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(chatId),
        isGroupChat: true,
      },
    },
    ...pipelineAggregation(),
  ]);

  const chatPayload = chat[0];

  if (!chatPayload) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Chat does not exists");
  }

  return new ApiResponse(StatusCodes.OK, "Group chat details fetched", chatPayload);
});

export const leaveGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, "chat does not exits");

  const existingParticipants = chat.participants;

  if (!existingParticipants.includes(participantId)) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Participant does not exists");
  }

  const updatedGroupChat = await chatModel.findByIdAndUpdate(
    chatId,
    {
      $pull: {
        participants: req.user._id,
      },
    },
    { new: true }
  );

  const updatedGroup = await chatModel.aggregate([
    {
      $match: {
        _id: updatedGroupChat._id,
        isGroupChat: true,
      },
    },
    ...pipelineAggregation(),
  ]);

  const updatedGroupPayload = updatedGroup[0];

  if (!updatedGroupPayload)
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Internal server error");

  return new ApiResponse(StatusCodes.OK, "Participant added successfully", updatedGroupPayload);
});

export const deleteOneOnOneChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  console.log(chatId);

  const chat = await chatModel.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(chatId),
      },
    },
    ...pipelineAggregation(),
  ]);

  const chatPayload = chat[0];

  if (!chatPayload) throw new ApiError(StatusCodes.NOT_FOUND, "chat does not exits");

  console.log(chatPayload);

  const deletedChat = await chatModel.findByIdAndDelete(chatId);
  // await deleteCascadeMessages(chatId);

  console.log("deleted Chat: ", deletedChat);

  const otherParticipants = chatPayload?.participants?.filter((participant) => {
    return participant.toString() !== req.user._id.toString();
  });

  console.log(chatPayload);

  mountNewChatEvent(req, SocketEventEnum.LEAVE_CHAT_EVENT, chatPayload, otherParticipants[0]._id);

  return new ApiResponse(StatusCodes.OK, "chat deleted successfully", {});
});

export const deleteGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, "chat does not exits");

  const groupChat = await chatModel.aggregate([
    {
      $match: {
        _id: chat._id,
        isGroupChat: true,
      },
    },
    ...pipelineAggregation(),
  ]);

  const chatPayload = groupChat[0];

  if (!chatPayload) throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Internal server error");

  // check if the user who is deleting is the group admin
  if (chatPayload.admin?.toString() !== req.user._id?.toString()) {
    throw new ApiError(404, "Only admin can delete the group");
  }

  await chatModel.findByIdAndDelete(chatId);
  await deleteCascadeMessages(chatId);

  chatPayload?.participants?.forEach((participant) => {
    if (req.user._id.toString() === participant._id.toString()) return;

    mountNewChatEvent(
      req,
      SocketEventEnum.LEAVE_CHAT_EVENT,
      chatPayload,
      participant._id.toString()
    );
  });
});

export const addParticipantToGroupChat = asyncHandler(async (req, res) => {
  const { chatId, participantId } = req.params;

  const chat = await chatModel.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, "Group chat does not exists");

  if (chat.admin?.toString() !== req.user._id.toString()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Only admin can add participants");
  }

  const existingParticipants = chat.participants;

  if (existingParticipants?.includes(participantId)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Participant already exists");
  }

  const updatedGroupChat = await chatModel.findByIdAndUpdate(
    chatId,
    {
      $push: {
        participants: participantId,
      },
    },
    { new: true }
  );

  const updatedGroup = await chatModel.aggregate([
    {
      $match: {
        _id: updatedGroupChat._id,
        isGroupChat: true,
      },
    },
    ...pipelineAggregation(),
  ]);

  const updatedGroupPayload = updatedGroup[0];

  updatedGroupPayload?.participants.forEach((participant) => {
    mountNewChatEvent(req, SocketEventEnum.NEW_CHAT_EVENT, updatedGroupPayload, participant._id);
  });

  return new ApiResponse(StatusCodes.OK, "Participant added successfully", updatedGroupPayload);
});

export const removeParticipantFromGroupChat = asyncHandler(async (req, res) => {
  const { chatId, participantId } = req.params;

  const chat = await chatModel.findOne({
    _id: mongoose.Types.Object(chatId),
    isGroupChat: true,
  });

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, "Chat does not exists");

  const existingParticipants = chat.participants;

  if (!existingParticipants.admin.toString() !== req.user._id.toString()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Only admin can remove participants");
  }

  if (!existingParticipants.includes(participantId)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Participant does not exists in group");
  }

  const updatedGroupChat = await chatModel.findByIdAndUpdate(
    chatId,
    {
      $pull: {
        participants: participantId,
      },
    },
    { new: true }
  );

  const updatedGroup = await chatModel.aggregate([
    {
      $match: {
        _id: updatedGroupChat._id,
        isGroupChat: true,
      },
    },
    ...pipelineAggregation(),
  ]);

  const updatedGroupPayload = updatedGroup[0];

  if (!updatedGroupPayload) {
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Internal server error");
  }

  updatedGroupPayload?.participants.forEach((participant) => {
    mountNewChatEvent(req, SocketEventEnum.LEAVE_CHAT_EVENT, updatedGroupPayload, participant._id);
  });

  return new ApiResponse(StatusCodes.OK, "Participant added successfully", updatedGroupPayload);
});

export const searchAvailableUsers = asyncHandler(async (req, res) => {
  const users = await userModel.aggregate([
    {
      $match: {
        _id: {
          $ne: req.user._id, // avoid logged in user
        },
      },
    },
    {
      $project: {
        avatar: 1,
        username: 1,
        email: 1,
      },
    },
  ]);

  return new ApiResponse(200, "Users fetched successfully", users);
});

export const getAllChats = asyncHandler(async (req, res) => {
  const chats = await chatModel.aggregate([
    {
      $match: {
        participants: { $elemMatch: { $eq: req.user._id } }, // get all chats that have logged in user as a participant
      },
    },
    {
      $sort: {
        updatedAt: -1,
      },
    },
    ...pipelineAggregation(),
  ]);

  return new ApiResponse(200, "User chats fetched successfully!", chats || []);
});
