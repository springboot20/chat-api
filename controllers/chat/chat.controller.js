import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { chatModel, messageModel, userModel } from '../../models/index.js';
import { removeLocalFile } from '../../helpers/index.js';
import { withTransaction } from '../../middlewares/mongoose.middleware.js';
import mongoose from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { mountNewChatEvent } from '../../socketIo/socket.js';
import { SocketEventEnum } from '../../constants/constants.js';

/**
 * @description Utility function which returns the pipeline stages to structure the chat schema with common lookups
 * @returns {mongoose.PipelineStage[]}
 */

const pipelineAggregation = () => {
  return [
    {
      $lookup: {
        from: 'user',
        foreignField: '_id',
        localField: 'participants',
        as: 'participants',
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
        from: 'chatmessages',
        foreignField: '_id',
        localField: 'lastMessage',
        as: 'lastMessage',
        pipeline: [
          {
            // get details of the sender
            $lookup: {
              from: 'users',
              foreignField: '_id',
              localField: 'sender',
              as: 'sender',
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
              sender: { $first: '$sender' },
            },
          },
        ],
      },
    },
    {
      $addFields: {
        lastMessage: { $first: '$lastMessage' },
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

  const receiver = await userModel.findOne({ _id: new mongoose.Types.ObjectId(receiverId) });

  if (!receiver) throw new ApiError(StatusCodes.NOT_FOUND, 'Receiver does not exists');

  if (req.user._id.toString() === receiver._id.toString())
    throw new ApiError(StatusCodes.BAD_REQUEST, 'message cannot be send to yourself');

  const chat = await chatModel.aggregate([
    {
      $match: {
        isGroupChat: false,
        $and: [
          {
            participants: {
              $elemMatch: {
                $ne: req.user._id,
              },
            },
          },
          {
            participants: {
              $elemMatch: {
                $ne: new mongoose.Types.ObjectId(receiver),
              },
            },
          },
        ],
      },
    },
    ...pipelineAggregation(),
  ]);

  if (chat.length) {
    return res
      .status(StatusCodes.OK)
      .json(new ApiResponse(StatusCodes.OK, chat[0], 'chat retrieved successfully'));
  }

  const newChatMessageInstanceWithSomeone = await chatModel.create({
    name: 'two user chat',
    isGroupChat: false,
    participants: [req.user._id, new mongoose.Types.ObjectId(receiverId)],
    admin: req.user._id,
  });

  const createdChat = await chatModel.aggregate([
    {
      $match: {
        _id: newChatMessageInstanceWithSomeone._id,
      },
    },
    ...pipelineAggregation(),
  ]);

  const chatPayload = createdChat[0];

  if (!chatPayload) throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal server error');

  chatPayload?.participants?.forEach((participant) => {
    if (req.user._id.toString() === participant._id.toString()) return;

    mountNewChatEvent(req, SocketEventEnum.NEW_CHAT_EVENT, chatPayload, participant._id.tostring());
  });

  return res
    .status(StatusCodes.OK)
    .json(new ApiResponse(StatusCodes.OK, chatPayload, 'Chat retrieved successfully'));
});

export const createGroupChat = asyncHandler(async (req, res) => {
  const { name, participants } = req.body;

  if (participants?.includes(req.user._id)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Participants payload should not contain the group creator'
    );
  }

  const groupChatMembers = [...new Set([...participants, req.user._id.toString()])];

  if (groupChatMembers.length < 3) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Seems like there is a duplicate members added');
  }

  const newGroupChatMessage = await chatModel.create({
    name: name ?? 'group chat',
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

  groupChatPayload?.participants?.forEach((participant) => {
    if (req.user._id.toString() === participant._id.toString()) return;
    mountNewChatEvent(
      req,
      SocketEventEnum.NEW_CHAT_EVENT,
      groupChatPayload,
      participant._id.toString()
    );
  });

  return res
    .status(StatusCodes.OK)
    .json(new ApiResponse(StatusCodes.OK, groupChatPayload, 'Chat retrieved successfully'));
});

export const changeGroupName = asyncHandler(
  withTransaction(async (req, res, session) => {
    const { name } = req.body;
    const { chatId } = req.params;

    const groupChat = await chatModel.findOne({
      _id: new mongoose.Types(chatId),
      isGroupChat: true,
    });

    if (!groupChat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat does not exists');
    if (groupChat._id.toString() === req.user._id.toString()) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'Not an Admin');
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

    await updatedChat.save({ session });

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
      mountNewChatEvent(req, SocketEventEnum.NEW_GROUP_NAME, chat, participant._id.toString());
    });

    return new ApiResponse(StatusCodes.OK, chat[0], 'Group chat nae updated');
  })
);

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
    throw new ApiError(StatusCodes.NOT_FOUND, 'Chat does not exists');
  }

  return new ApiResponse(StatusCodes.OK, 'Group chat details fetched', chatPayload);
});

export const leaveGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'chat does not exits');

  const existingParticipants = chat.participants;

  if (!existingParticipants.includes(participantId)) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Participant does not exists');
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
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal server error');

  return new ApiResponse(StatusCodes.OK, 'Participant added successfully', updatedGroupPayload);
});

export const deleteOneOnOneChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(chatId),
        isGroupChat: false,
      },
    },
    ...pipelineAggregation(),
  ]);

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'chat does not exits');

  const chatPayload = chat[0];

  if (!chatPayload) throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal server error');

  await chatModel.findByIdAndDelete(chatId);
  await deleteCascadeMessages(chatId);

  const otherParticipants = chatPayload?.participants?.filter(
    (participant) => participant._id.toString() !== req.user._id.toString()
  );

  mountNewChatEvent(req, SocketEventEnum.LEAVE_CHAT_EVENT, chatPayload, otherParticipants[0]._id);
});

export const deleteGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'chat does not exits');

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

  if (!chatPayload) throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal server error');

  // check if the user who is deleting is the group admin
  if (chatPayload.admin?.toString() !== req.user._id?.toString()) {
    throw new ApiError(404, 'Only admin can delete the group');
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
    _id: mongoose.Types.Object(chatId),
    isGroupChat: true,
  });

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat does not exists');

  const existingParticipants = chat.participants;

  if (!existingParticipants.admin.toString() !== req.user._id.toString()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Only admin can add participants');
  }

  if (existingParticipants.includes(participantId)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Participant already exists');
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

  return new ApiResponse(StatusCodes.OK, 'Participant added successfully', updatedGroupPayload);
});

export const removeParticipantFromGroupChat = asyncHandler(async (req, res) => {
  const { chatId, participantId } = req.params;

  const chat = await chatModel.findOne({
    _id: mongoose.Types.Object(chatId),
    isGroupChat: true,
  });

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat does not exists');

  const existingParticipants = chat.participants;

  if (!existingParticipants.admin.toString() !== req.user._id.toString()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Only admin can remove participants');
  }

  if (!existingParticipants.includes(participantId)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Participant does not exists in group');
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
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal server error');
  }

  updatedGroupPayload?.participants.forEach((participant) => {
    mountNewChatEvent(req, SocketEventEnum.LEAVE_CHAT_EVENT, updatedGroupPayload, participant._id);
  });

  return new ApiResponse(StatusCodes.OK, 'Participant added successfully', updatedGroupPayload);
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

  return res.status(200).json(new ApiResponse(200, users, 'Users fetched successfully'));
});
