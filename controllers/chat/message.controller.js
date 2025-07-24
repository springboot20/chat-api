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
        reactions: {
          $map: {
            input: "$reactions",
            as: "reaction",
            in: {
              messageId: "$$reaction.messageId",
              emoji: "$$reaction.emoji",
              userId: "$$reaction.userId",
              userIds: "$$reaction.userIds",
            },
          },
        },
      },
    },
    {
      $lookup: {
        from: "users",
        let: { reactionUserIds: "$reactions.userIds" },
        as: "reactionUsers",
        pipeline: [
          {
            $match: {
              $expr: {
                $in: [
                  "$_id",
                  {
                    $reduce: {
                      input: "$$reactionUserIds",
                      initialValue: [],
                      in: { $setUnion: ["$$value", "$$this"] },
                    },
                  },
                ],
              },
            },
          },
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
        reactions: {
          $map: {
            input: "$reactions",
            as: "reaction",
            in: {
              messageId: "$$reaction.messageId",
              emoji: "$$reaction.emoji",
              userId: "$$reaction.userId",
              userIds: "$$reaction.userIds",
              users: {
                $filter: {
                  input: "$reactionUsers",
                  as: "user",
                  cond: {
                    $in: ["$$user._id", "$$reaction.userIds"],
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      $project: {
        reactionUsers: 0,
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

export const reactToMessage = asyncHandler(async (req) => {
  const { chatId, messageId } = req.params;
  const { emoji } = req.body;
  const userId = req.user._id;

  // Validate emoji input
  if (!emoji || typeof emoji !== "string" || emoji.trim() === "") {
    throw new ApiError(400, "Valid emoji is required");
  }

  // Find the chat
  const chat = await chatModel.findById(chatId);
  if (!chat) {
    throw new ApiError(404, "Chat not found");
  }

  // Find the message
  const chatMessage = await messageModel.findOne({ chat: chat._id, _id: messageId });
  if (!chatMessage) {
    throw new ApiError(404, "Chat message not found");
  }

  const existingReactions = chatMessage.reactions || [];
  const isGroupChat = chat.isGroupChat;
  let updatedReactions = [...existingReactions];

  if (isGroupChat) {
    // Find the reaction for the given emoji
    const reactionIndex = updatedReactions.findIndex((reaction) => reaction.emoji === emoji);

    // Remove user's ID from all other reactions
    // updatedReactions = updatedReactions
    //   .map((reaction) => ({
    //     ...reaction,
    //     userIds: reaction.userIds.filter(
    //       (id) => id.toString() !== userId.toString() || reaction.emoji === emoji
    //     ),
    //   }))
    //   .filter((reaction) => reaction.userIds.length > 0);

    if (reactionIndex !== -1) {
      const userAlreadyReacted = updatedReactions[reactionIndex].userIds.some(
        (id) => id.toString() === userId.toString()
      );
      console.log("user already reacted: ", userAlreadyReacted);

      // Emoji exists; check if user already reacted
      if (!userAlreadyReacted) {
        // User hasn't reacted with this emoji; add their ID
        updatedReactions[reactionIndex].userIds.push(userId);

        console.log(updatedReactions[reactionIndex]);
      } else {
        // User already reacted; remove their ID (toggle off)
        updatedReactions[reactionIndex].userIds = updatedReactions[reactionIndex].userIds.filter(
          (id) => id.toString() !== userId.toString()
        );
        // Remove reaction if no users remain
        if (updatedReactions[reactionIndex].userIds.length === 0) {
          updatedReactions.splice(reactionIndex, 1);
        }
      }
    } else {
      // New emoji reaction
      updatedReactions.push({
        emoji,
        userIds: [userId],
        messageId,
      });
    }
  } else {
    // Private chat: Replace user's existing reaction
    updatedReactions = existingReactions.filter(
      (reaction) => reaction.userId.toString() !== userId.toString()
    );

    updatedReactions.push({
      emoji,
      userIds: [userId],
      messageId,
    });
  }

  // Update the message with new reactions
  const updatedMessage = await messageModel.findByIdAndUpdate(
    messageId,
    {
      $set: { reactions: updatedReactions },
    },
    { new: true }
  );

  if (!updatedMessage) {
    throw new ApiError(500, "Failed to update message");
  }

  // Fetch the updated message with sender details
  const messageWithSender = await messageModel.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(updatedMessage._id),
      },
    },
    ...pipelineAggregation(),
  ]);

  if (!messageWithSender[0]) {
    throw new ApiError(500, "Failed to fetch updated message");
  }

  const messagePayload = messageWithSender[0];

  // Notify participants
  chat.participants.forEach((participantObjId) => {
    mountNewChatEvent(
      req,
      SocketEventEnum.REACTION_RECEIVED_EVENT,
      messagePayload,
      participantObjId.toString()
    );
  });

  return new ApiResponse(200, "Reaction updated", messagePayload);
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
