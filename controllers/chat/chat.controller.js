import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { chatModel, ContactModel, messageModel, userModel } from '../../models/index.js';
import { removeLocalFile } from '../../helper.js';
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
        from: 'users',
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
    }),
  );

  attachments.forEach((attachment) => {
    removeLocalFile(attachment.localPath);
  });

  await messageModel.deleteMany({ chat: new mongoose.Types.ObjectId(chatId) });
};

export const GetOrCreateChatMessage = asyncHandler(async (req, res) => {
  const { receiverId } = req.params;
  const senderId = req.user._id;

  // 1. Prevent self-chatting
  if (senderId.toString() === receiverId) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'You cannot send messages to yourself');
  }

  // 2. Parallel check for receiver existence and block status
  const [receiver, blockStatus] = await Promise.all([
    userModel.findById(receiverId),
    ContactModel.findOne({
      $or: [
        { owner: senderId, contact: receiverId, isBlocked: true }, // I blocked them
        { owner: receiverId, contact: senderId, isBlocked: true }, // They blocked me
      ],
    }),
  ]);

  if (!receiver) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Receiver does not exist');
  }

  // 3. Enforcement of the Block Record
  if (blockStatus) {
    const isMeeWhoBlocked = blockStatus.owner.toString() === senderId.toString();
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      isMeeWhoBlocked
        ? 'You have blocked this user. Unblock them to chat.'
        : 'Communication with this user is restricted.',
    );
  }

  // 4. Find existing 1-on-1 chat
  const chat = await chatModel.aggregate([
    {
      $match: {
        isGroupChat: false,
        participants: { $all: [senderId, new mongoose.Types.ObjectId(receiverId)] },
      },
    },
    ...pipelineAggregation(),
  ]);

  // 5. If chat exists, return it (no socket emit needed)
  if (chat.length > 0) {
    return new ApiResponse(StatusCodes.OK, 'Chat retrieved successfully', chat[0]);
  }

  // 6. Create new chat if it doesn't exist
  const newChatInstance = await chatModel.create({
    name: 'One-on-One Chat',
    isGroupChat: false,
    participants: [senderId, new mongoose.Types.ObjectId(receiverId)],
    admin: senderId,
  });

  // 7. Aggregate the newly created chat to get populated fields
  const createdChat = await chatModel.aggregate([
    { $match: { _id: newChatInstance._id } },
    ...pipelineAggregation(),
  ]);

  const chatPayload = createdChat[0];

  if (!chatPayload) {
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      'Internal server error during chat creation',
    );
  }

  // 8. Emit Socket Event for brand NEW chats only
  const io = req.app.get('io');
  if (io) {
    chatPayload.participants.forEach((participant) => {
      io.to(`user:${participant._id}`).emit(SocketEventEnum.NEW_CHAT_EVENT, chatPayload);
    });
  }

  return new ApiResponse(StatusCodes.CREATED, 'Chat created successfully', chatPayload);
});

export const createGroupChat = asyncHandler(async (req, res) => {
  const { name, participants } = req.body; // participants is an array of IDs
  const creatorId = req.user._id;

  // 1. Basic Validation
  if (!participants || !Array.isArray(participants)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Participants list is required');
  }

  if (participants.includes(creatorId.toString())) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Participants payload should not contain the group creator',
    );
  }

  // Ensure unique members and include the creator
  const uniqueMemberIds = [...new Set([...participants, creatorId.toString()])];

  // Group needs at least 3 members (Creator + 2 others)
  if (uniqueMemberIds.length < 3) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'A group chat must have at least 3 unique members');
  }

  // 2. Bidirectional Block Check
  // We check if there is ANY block record between the creator and any participant
  const blockRecord = await ContactModel.findOne({
    $or: [
      { owner: creatorId, contact: { $in: participants }, isBlocked: true }, // Creator blocked someone
      { owner: { $in: participants }, contact: creatorId, isBlocked: true }, // Someone blocked the creator
    ],
  });

  if (blockRecord) {
    const isCreatorWhoBlocked = blockRecord.owner.toString() === creatorId.toString();
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      isCreatorWhoBlocked
        ? 'You cannot add a user you have blocked to a group.'
        : 'One or more users have restricted communication with you.',
    );
  }

  // 3. Create the Group Chat
  const newGroupChatMessage = await chatModel.create({
    name: name || 'Group Chat',
    admin: creatorId,
    participants: uniqueMemberIds,
    isGroupChat: true,
  });

  // 4. Aggregate to get full details (using your pipeline for consistency)
  const createdGroupChat = await chatModel.aggregate([
    {
      $match: {
        _id: newGroupChatMessage._id,
      },
    },
    ...pipelineAggregation(), // Ensures participants details are populated
  ]);

  const groupChatPayload = createdGroupChat[0];

  if (!groupChatPayload) {
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to create group chat');
  }

  // 5. Emit Socket Events to all members
  const io = req.app.get('io');
  if (io) {
    groupChatPayload.participants.forEach((participant) => {
      // Logic assumes participant object has _id after aggregation
      const participantId = participant._id || participant;
      io.to(`user:${participantId}`).emit(SocketEventEnum.NEW_CHAT_EVENT, groupChatPayload);
    });
  }

  return new ApiResponse(StatusCodes.CREATED, 'Group chat created successfully', groupChatPayload);
});

export const changeGroupName = asyncHandler(async (req, res) => {
  const { name } = req.body;
  const { chatId } = req.params;

  const groupChat = await chatModel.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
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
    { new: true },
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

  const groupPayload = chat[0];

  const io = req.app.get('io');
  if (io) io.to(`chat:${chatId}`).emit(SocketEventEnum.NEW_GROUP_NAME, groupPayload);

  return new ApiResponse(StatusCodes.OK, 'Group chat name updated', groupPayload);
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
    throw new ApiError(StatusCodes.NOT_FOUND, 'Chat does not exists');
  }

  return new ApiResponse(StatusCodes.OK, 'Group chat details fetched', chatPayload);
});

export const leaveGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.findById(chatId);
  if (!chat || !chat.isGroupChat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat does not exist');

  if (!chat.participants.includes(req.user._id))
    throw new ApiError(StatusCodes.BAD_REQUEST, 'You are not a participant');

  const updatedChat = await chatModel.findByIdAndUpdate(
    chatId,
    { $pull: { participants: req.user._id } },
    { new: true },
  );

  const updatedGroup = await chatModel.aggregate([
    { $match: { _id: updatedChat._id } },
    ...pipelineAggregation(),
  ]);

  const groupPayload = updatedGroup[0];
  if (!groupPayload) throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal server error');

  const io = req.app.get('io');
  if (io) {
    io.to(`chat:${chatId}`).emit(SocketEventEnum.NEW_GROUP_NAME, groupPayload);
  }

  return new ApiResponse(StatusCodes.OK, 'You have left the group', groupPayload);
});

export const deleteOneOnOneChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(chatId) } },
    ...pipelineAggregation(),
  ]);

  const chatPayload = chat[0];
  if (!chatPayload) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat does not exist');

  await chatModel.findByIdAndDelete(chatId);
  // Optionally delete messages
  // await deleteCascadeMessages(chatId);

  const io = req.app.get('io');
  if (io) {
    chatPayload.participants.forEach((participant) => {
      io.to(`user:${participant._id}`).emit(SocketEventEnum.LEAVE_CHAT_EVENT, chatPayload);
    });
  }

  return new ApiResponse(StatusCodes.OK, 'Chat deleted successfully', {});
});

export const deleteGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.findById(chatId);
  if (!chat || !chat.isGroupChat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat does not exist');

  if (chat.admin.toString() !== req.user._id.toString())
    throw new ApiError(StatusCodes.FORBIDDEN, 'Only admin can delete the group');

  const groupPayload = await chatModel
    .aggregate([{ $match: { _id: chat._id } }, ...pipelineAggregation()])
    .then((r) => r[0]);

  if (!groupPayload) throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal error');

  await chatModel.findByIdAndDelete(chatId);
  await deleteCascadeMessages(chatId);

  const io = req.app.get('io');
  if (io) {
    groupPayload.participants.forEach((participant) => {
      io.to(`user:${participant._id}`).emit(SocketEventEnum.LEAVE_CHAT_EVENT, groupPayload);
    });
  }

  return new ApiResponse(StatusCodes.OK, 'Group chat deleted successfully', {});
});

export const addParticipantToGroupChat = asyncHandler(async (req, res) => {
  const { chatId, participantId } = req.params;

  const chat = await chatModel.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Group chat does not exists');

  if (chat.admin?.toString() !== req.user._id.toString()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Only admin can add participants');
  }

  const existingParticipants = chat.participants;

  if (existingParticipants?.includes(participantId)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Participant already exists');
  }

  const updatedGroupChat = await chatModel.findByIdAndUpdate(
    chatId,
    {
      $push: {
        participants: participantId,
      },
    },
    { new: true },
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

  const groupPayload = updatedGroup[0];

  const io = req.app.get('io');
  if (io) io.to(`chat:${chatId}`).emit(SocketEventEnum.NEW_GROUP_NAME, groupPayload);

  return new ApiResponse(StatusCodes.OK, 'Participant added successfully', groupPayload);
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
    { new: true },
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

  const groupPayload = updatedGroup[0];

  const io = req.app.get('io');
  if (io) io.to(`chat:${chatId}`).emit(SocketEventEnum.NEW_GROUP_NAME, groupPayload);

  return new ApiResponse(StatusCodes.OK, 'Participant removed successfully', groupPayload);
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

  return new ApiResponse(200, 'User chats fetched successfully!', chats || []);
});
