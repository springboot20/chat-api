import { StatusCodes } from "http-status-codes";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { chatModel, messageModel } from "../../models/index.js";
import { getLocalFilePath, getStaticFilePath, removeLocalFile } from "../../helper.js";
import mongoose from "mongoose";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { mountNewChatEvent } from "../../socketIo/socket.js";
import { SocketEventEnum } from "../../constants/constants.js";

/**
 * @return {mongoose.PipelineStage[]}
 */

const pipelineAggregation = () => {
  return [
    {
      $lookup: {
        from: "users",
        localField: "sender",
        foreignField: "_id",
        as: "sender",
        pipeline: [
          {
            $project: {
              _id: 1,
              username: 1,
              avatar: 1,
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
    {
      $lookup: {
        from: "chatmessages", // Reference the same collection
        localField: "replyId",
        foreignField: "_id",
        as: "repliedMessage",
        pipeline: [
          // Nested lookup for repliedMessage's sender
          {
            $lookup: {
              from: "users",
              localField: "sender",
              foreignField: "_id",
              as: "sender",
              pipeline: [
                {
                  $project: {
                    _id: 1,
                    username: 1,
                    avatar: 1,
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
          // Project only necessary fields for repliedMessage
          {
            $project: {
              _id: 1,
              content: 1,
              sender: 1,
              isDeleted: 1,
              attachments: 1,
              replyId: 1,
              updatedAt: 1,
            },
          },
        ],
      },
    },
    {
      $addFields: {
        repliedMessage: { $first: "$repliedMessage" }, // Flatten the array
      },
    },
  ];
};

export const getAllChats = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Chat not found");
  }

  if (!chat.participants.includes(req.user._id)) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, "You are not a participant of this chat");
  }

  const messages = await messageModel.aggregate([
    {
      $match: {
        chat: new mongoose.Types.ObjectId(chatId),
      },
    },
    ...pipelineAggregation(),
  ]);

  return new ApiResponse(200, "Messages fetched successfully", messages || []);
});

export const createMessage = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { content, mentions = [] } = req.body;

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Chat not found");
  }

  if (!chat.participants.includes(req.user._id)) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, "You are not a participant of this chat");
  }

  const attachments = [];

  console.log("line 95: ", req.files?.attachments);

  if (req.files && req.files?.attachments?.length > 0) {
    req.files?.attachments?.map((attachment) => {
      attachments.push({
        url: getStaticFilePath(req, attachment.filename),
        localPath: getLocalFilePath(attachment.filename),
      });
    });
  }

  console.log(JSON.parse(mentions));
  const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;
  console.log(parsedMentions);

  const message = await messageModel.create({
    content: content || "",
    sender: new mongoose.Types.ObjectId(req.user._id),
    chat: new mongoose.Types.ObjectId(chatId),
    attachments,
    mentions: Array.isArray(parsedMentions) ? parsedMentions : [],
  });

  const updatedMessage = await chatModel.findByIdAndUpdate(
    chatId,
    {
      $set: {
        lastMessage: message._id,
      },
    },
    { new: true }
  );

  const messageWithSender = await messageModel.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(message._id),
      },
    },
    ...pipelineAggregation(),
  ]);

  const messagePayload = messageWithSender[0];

  console.log(messageWithSender);

  if (!messagePayload)
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "internal server error");

  updatedMessage.participants.forEach((participantObjId) => {
    if (participantObjId.toString() === req.user._id.toString()) return;
    console.log(participantObjId);

    mountNewChatEvent(
      req,
      SocketEventEnum.NEW_MESSAGE_RECEIVED_EVENT,
      messageWithSender[0],
      participantObjId.toString()
    );
  });
  return new ApiResponse(200, "Message created successfully", messagePayload);
});

export const reactToMessage = asyncHandler(async (req, res) => {
  const { chatId, messageId } = req.params;
  const { emoji } = req.body;
  const userId = req.user._id;

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Chat not found");
  }

  const chatMessage = await messageModel.findOne({ chat: chat?._id, _id: messageId });

  if (!chatMessage) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Chat message not found");
  }

  const newReaction = { emoji, userId };
  const existingReactions = chatMessage?.reactions || [];

  const updatedReactions = existingReactions.filter(
    (reaction) => reaction.userId.toString() !== userId.toString()
  );
  updatedReactions.push(newReaction);

  const isGroupChat = chat?.isGroupChat;

  console.log(isGroupChat);

  const updatedMessage = await messageModel.findByIdAndUpdate(
    messageId,
    isGroupChat
      ? {
          $push: {
            reactions: updatedReactions,
          },
        }
      : {
          $set: {
            reactions: newReaction,
          },
        },
    { new: true }
  );

  console.log([...existingReactions, newReaction]);

  if (!updatedMessage) {
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Failed to update message");
  }

  const messageWithSender = await messageModel.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(updatedMessage._id),
      },
    },
    ...pipelineAggregation(),
  ]);

  if (!messageWithSender[0]) {
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Failed to fetch updated message");
  }

  const messagePayload = messageWithSender[0];

  chat.participants.forEach((participantObjId) => {
    // if (participantObjId.toString() === userId.toString()) return;
    mountNewChatEvent(
      req,
      SocketEventEnum.REACTION_RECEIVED_EVENT,
      messagePayload,
      participantObjId.toString()
    );
  });

  return new ApiResponse(StatusCodes.OK, "Reaction added", messagePayload);
});

export const deleteChatMessage = asyncHandler(async (req, res) => {
  const { messageId, chatId } = req.params;
  // const userId = req.user._id;

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Chat not found");
  }

  const message = await messageModel.findOne({ chat: chat?._id, _id: messageId });

  if (!message) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Chat message not found");
  }

  const chatAggregate = await chatModel.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(chatId),
      },
    },
    ...pipelineAggregation(),
  ]);

  const chatPayload = chatAggregate[0];

  if (!chatPayload) throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Internal server error");

  message.attachments.map((file) => {
    removeLocalFile(file.localPath);
  });

  const updatedMessage = await messageModel.findOneAndUpdate(
    { _id: messageId, chat: chatId },
    {
      $set: {
        isDeleted: true,
      },
    },
    { new: true }
  );

  const messageWithSender = await messageModel.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(message._id),
      },
    },
    {
      $lookup: {
        from: "messages",
        localField: "replyId",
        foreignField: "_id",
        as: "repliedMessage",
      },
    },
    ...pipelineAggregation(),
  ]);

  const messagePayload = messageWithSender[0];
  console.log(messageWithSender);

  if (!messagePayload)
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "internal server error");

  chatPayload?.participants.forEach((participantObjId) => {
    mountNewChatEvent(
      req,
      SocketEventEnum.CHAT_MESSAGE_DELETE_EVENT,
      messagePayload,
      participantObjId.toString()
    );
  });

  return new ApiResponse(StatusCodes.OK, "Message deleted successfully", messagePayload);
});

export const replyToMessage = asyncHandler(async (req) => {
  const { chatId, messageId } = req.params;
  const { content, mentions = [] } = req.body;

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Chat not found");
  }

  if (!chat.participants.includes(req.user._id)) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, "You are not a participant of this chat");
  }

  const attachments = [];
  const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;

  if (req.files && req.files?.attachments?.length > 0) {
    req.files?.attachments?.map((attachment) => {
      attachments.push({
        url: getStaticFilePath(req, attachment.filename),
        localPath: getLocalFilePath(attachment.filename),
      });
    });
  }

  const message = await messageModel.create({
    content: content || "",
    sender: new mongoose.Types.ObjectId(req.user._id),
    chat: new mongoose.Types.ObjectId(chatId),
    attachments,
    replyId: messageId,
    mentions: Array.isArray(parsedMentions) ? parsedMentions : [],
  });

  const updatedMessage = await chatModel.findByIdAndUpdate(
    chatId,
    {
      $set: {
        lastMessage: message._id,
      },
    },
    { new: true }
  );

  const messageWithSender = await messageModel.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(message._id),
      },
    },
    {
      $lookup: {
        from: "messages",
        localField: "replyId",
        foreignField: "_id",
        as: "repliedMessage",
      },
    },
    ...pipelineAggregation(),
  ]);

  const messagePayload = messageWithSender[0];

  console.log(messageWithSender);

  if (!messagePayload)
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "internal server error");

  updatedMessage.participants.forEach((participantObjId) => {
    if (participantObjId.toString() === req.user._id.toString()) return;
    console.log(participantObjId);

    mountNewChatEvent(
      req,
      SocketEventEnum.NEW_MESSAGE_RECEIVED_EVENT,
      messagePayload,
      participantObjId.toString()
    );
  });

  return new ApiResponse(StatusCodes.OK, "replied to message successfully", messagePayload);
});
