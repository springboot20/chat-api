import { StatusCodes } from "http-status-codes";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { chatModel, messageModel } from "../../models/index.js";
import { getLocalFilePath, getStaticFilePath } from "../../helpers/index.js";
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
  const { content } = req.body;

  if (!content) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Message content or file attachments is required");
  }

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

  console.log(attachments);

  const message = await messageModel.create({
    content: content || "",
    sender: new mongoose.Types.ObjectId(req.user._id),
    chat: new mongoose.Types.ObjectId(chatId),
    attachments,
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
