import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { chatModel, messageModel } from '../../models/index.js';
import { getLocalFilePath, getStaticFilePath, removeLocalFile } from '../../helper.js';
import mongoose from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { SocketEventEnum } from '../../constants/constants.js';
import { isUserOnline, notifyChatParticipants, onlineUsers } from '../../socketIo/socket.js';

/**
 * @return {mongoose.PipelineStage[]}
 */

const pipelineAggregation = () => {
  return [
    {
      $lookup: {
        from: 'users',
        localField: 'sender',
        foreignField: '_id',
        as: 'sender',
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
        sender: { $first: '$sender' },
      },
    },
    {
      $lookup: {
        from: 'chatmessages', // Reference the same collection
        localField: 'replyId',
        foreignField: '_id',
        as: 'repliedMessage',
        pipeline: [
          // Nested lookup for repliedMessage's sender
          {
            $lookup: {
              from: 'users',
              localField: 'sender',
              foreignField: '_id',
              as: 'sender',
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
              sender: { $first: '$sender' },
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
            input: '$reactions',
            as: 'reaction',
            in: {
              messageId: '$$reaction.messageId',
              emoji: '$$reaction.emoji',
              userId: '$$reaction.userId',
              userIds: '$$reaction.userIds',
            },
          },
        },
      },
    },
    {
      $lookup: {
        from: 'users',
        let: { reactionUserIds: '$reactions.userIds' },
        as: 'reactionUsers',
        pipeline: [
          {
            $match: {
              $expr: {
                $in: [
                  '$_id',
                  {
                    $ifNull: [
                      {
                        $reduce: {
                          input: {
                            $filter: {
                              input: '$$reactionUserIds',
                              as: 'userIdArray',
                              cond: { $ne: ['$$userIdArray', null] },
                            },
                          },
                          initialValue: [],
                          in: { $setUnion: ['$$value', '$$this'] },
                        },
                      },
                      [],
                    ],
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
            input: '$reactions',
            as: 'reaction',
            in: {
              messageId: '$$reaction.messageId',
              emoji: '$$reaction.emoji',
              userId: '$$reaction.userId',
              userIds: '$$reaction.userIds',
              users: {
                $filter: {
                  input: '$reactionUsers',
                  as: 'user',
                  cond: {
                    $in: ['$$user._id', '$$reaction.userIds'],
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
        repliedMessage: { $first: '$repliedMessage' }, // Flatten the array
        status: { $ifNull: ['$status', 'sent'] },
        deliveredTo: { $ifNull: ['$deliveredTo', []] },
        seenBy: { $ifNull: ['$seenBy', []] },
      },
    },
  ];
};

export const getAllChats = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Chat not found');
  }

  if (!chat.participants.includes(req.user._id)) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not a participant of this chat');
  }

  const messages = await messageModel.aggregate([
    {
      $match: {
        chat: new mongoose.Types.ObjectId(chatId),
      },
    },
    ...pipelineAggregation(),
  ]);

  return new ApiResponse(200, 'Messages fetched successfully', { chatId, messages } || []);
});

export const createMessage = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { content, mentions = [] } = req.body;

  const chat = await chatModel.findById(chatId);
  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat not found');
  if (!chat.participants.includes(req.user._id))
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not a participant of this chat');

  // Handle attachments
  const attachments = [];
  if (req.files?.attachments?.length > 0) {
    req.files.attachments.forEach((attachment) => {
      attachments.push({
        url: getStaticFilePath(req, attachment.filename),
        localPath: getLocalFilePath(attachment.filename),
      });
    });
  }

  const parsedMentions = typeof mentions === 'string' ? JSON.parse(mentions) : mentions;

  // 1️⃣ Create message
  const message = await messageModel.create({
    content: content || '',
    sender: req.user._id,
    chat: chatId,
    attachments,
    mentions: Array.isArray(parsedMentions) ? parsedMentions : [],
  });

  // 2️⃣ Update lastMessage
  await chatModel.findByIdAndUpdate(chatId, { $set: { lastMessage: message._id } });

  // 4️⃣ Aggregate message for payload
  const [messagePayload] = await messageModel.aggregate([
    { $match: { _id: message._id } },
    ...pipelineAggregation(),
  ]);

  if (!messagePayload)
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal server error');

  // 5️⃣ Aggregate updated chat
  const [chatPayload] = await chatModel.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(chatId) } },
    {
      $lookup: {
        from: 'users',
        localField: 'participants',
        foreignField: '_id',
        as: 'participants',
        pipeline: [{ $project: { password: 0, refreshToken: 0 } }],
      },
    },
    {
      $lookup: {
        from: 'chatmessages',
        localField: 'lastMessage',
        foreignField: '_id',
        as: 'lastMessage',
        pipeline: [
          {
            $lookup: {
              from: 'users',
              localField: 'sender',
              foreignField: '_id',
              as: 'sender',
              pipeline: [{ $project: { username: 1, avatar: 1 } }],
            },
          },
          { $addFields: { sender: { $first: '$sender' } } },
        ],
      },
    },
    { $addFields: { lastMessage: { $first: '$lastMessage' } } },
  ]);

  // 6️⃣ Emit events to the chat room
  const io = req.app.get('io');

  if (io) {
    // 🚚 Delivered logic (online + inside chat room)
    const deliveredNow = [];

    for (const participantId of chat.participants) {
      if (participantId.equals(req.user._id)) continue;

      const sockets = onlineUsers.get(participantId.toString());
      if (!sockets) continue;

      for (const socketId of sockets) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket?.rooms.has(`chat:${chatId}`)) {
          deliveredNow.push(participantId.toString());
          break;
        }
      }
    }

    if (deliveredNow.length) {
      await messageModel.findByIdAndUpdate(message._id, {
        $addToSet: { deliveredTo: { $each: deliveredNow.map((id) => id.toString()) } },
        $set: { status: 'delivered' },
      });

      messagePayload.status = 'delivered';
      messagePayload.deliveredTo = deliveredNow.map((id) => id.toString());

      await notifyChatParticipants({
        io,
        chat,
        actorId: req.user._id,
        event: SocketEventEnum.MESSAGE_DELIVERED_EVENT,
        payload: {
          chatId,
          messageId: message._id,
          deliveredTo: deliveredNow.map((id) => id.toString()),
        },
      });
    }

    await Promise.all([
      notifyChatParticipants({
        io,
        chat,
        actorId: req.user._id,
        event: SocketEventEnum.NEW_MESSAGE_RECEIVED_EVENT,
        payload: messagePayload,
      }),

      notifyChatParticipants({
        io,
        chat,
        actorId: req.user._id,
        event: SocketEventEnum.UPDATE_CHAT_LAST_MESSAGE_EVENT,
        payload: chatPayload,
      }),
    ]);
  }

  return new ApiResponse(StatusCodes.OK, 'Message created successfully', messagePayload);
});

export const deleteChatMessage = asyncHandler(async (req, res) => {
  const { messageId, chatId } = req.params;

  const chat = await chatModel.findById(chatId);
  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat not found');

  const message = await messageModel.findOne({ chat: chat._id, _id: messageId });
  if (!message) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat message not found');

  // Remove local files if any
  message.attachments.forEach((file) => removeLocalFile(file.localPath));

  const updatedMessage = await messageModel.findOneAndUpdate(
    { _id: messageId, chat: chatId },
    { $set: { isDeleted: true } },
    { new: true }
  );

  const messageWithSender = await messageModel.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(updatedMessage._id) } },
    ...pipelineAggregation(),
  ]);

  const messagePayload = messageWithSender[0];
  if (!messagePayload) throw new ApiError(500, 'Internal server error');

  // ✅ Emit delete event to chat room
  const io = req.app.get('io');
  if (io) {
    await notifyChatParticipants({
      io,
      chat,
      actorId: req.user._id,
      event: SocketEventEnum.CHAT_MESSAGE_DELETE_EVENT,
      payload: messagePayload,
    });
  }

  return new ApiResponse(StatusCodes.OK, 'Message deleted successfully', messagePayload);
});

export const reactToMessage = asyncHandler(async (req) => {
  const { chatId, messageId } = req.params;
  const { emoji } = req.body;
  const userId = req.user._id;

  if (!emoji || typeof emoji !== 'string' || emoji.trim() === '') {
    throw new ApiError(400, 'Valid emoji is required');
  }

  const chat = await chatModel.findById(chatId);
  if (!chat) throw new ApiError(404, 'Chat not found');

  const chatMessage = await messageModel.findOne({ chat: chat._id, _id: messageId });
  if (!chatMessage) throw new ApiError(404, 'Chat message not found');

  const existingReactions = chatMessage.reactions || [];
  const isGroupChat = chat.isGroupChat;
  let updatedReactions = [...existingReactions];

  if (isGroupChat) {
    // 🔹 GROUP CHAT: User can have only ONE reaction (toggle/replace)

    // Step 1: Remove user from ALL reactions first
    updatedReactions = updatedReactions
      .map((reaction) => ({
        ...reaction,
        userIds: reaction.userIds.filter((id) => id.toString() !== userId.toString()),
      }))
      .filter((reaction) => reaction.userIds.length > 0); // Remove empty reactions

    // Step 2: Check if user previously reacted with this SAME emoji
    const userPreviouslyUsedThisEmoji = existingReactions.some(
      (reaction) =>
        reaction.emoji === emoji &&
        reaction.userIds.some((id) => id.toString() === userId.toString())
    );

    // Step 3: If NOT toggling off (different emoji or no previous reaction), add new reaction
    if (!userPreviouslyUsedThisEmoji) {
      // Check if this emoji already exists (from other users) in the CLEANED array
      const existingEmojiIndex = updatedReactions.findIndex((r) => r.emoji === emoji);

      if (existingEmojiIndex !== -1) {
        // Emoji exists, add user to it
        updatedReactions[existingEmojiIndex].userIds.push(userId);
      } else {
        // New emoji, create it
        updatedReactions.push({
          emoji,
          userIds: [userId],
          messageId,
        });
      }
    }
  } else {
    // 🔹 ONE-ON-ONE CHAT: User can have only ONE reaction (toggle/replace)

    // Step 1: Remove user from ALL reactions first
    updatedReactions = updatedReactions
      .map((reaction) => ({
        ...reaction,
        userIds: reaction.userIds.filter((id) => id.toString() !== userId.toString()),
      }))
      .filter((reaction) => reaction.userIds.length > 0); // Remove empty reactions

    // Step 2: Check if user previously reacted with this SAME emoji
    const userPreviouslyUsedThisEmoji = existingReactions.some(
      (reaction) =>
        reaction.emoji === emoji &&
        reaction.userIds.some((id) => id.toString() === userId.toString())
    );

    // Step 3: If NOT toggling off, add new reaction
    if (!userPreviouslyUsedThisEmoji) {
      // Check if this emoji already exists in the CLEANED array
      const existingEmojiIndex = updatedReactions.findIndex((r) => r.emoji === emoji);

      if (existingEmojiIndex !== -1) {
        // Emoji exists, add user to it
        updatedReactions[existingEmojiIndex].userIds.push(userId);
      } else {
        // New emoji, create it
        updatedReactions.push({
          emoji,
          userIds: [userId],
          messageId,
        });
      }
    }
  }

  // Update the message in database
  const updatedMessage = await messageModel.findByIdAndUpdate(
    messageId,
    { $set: { reactions: updatedReactions } },
    { new: true }
  );

  if (!updatedMessage) throw new ApiError(500, 'Failed to update message');

  // Fetch updated message with populated data
  const messageWithSender = await messageModel.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(updatedMessage._id) } },
    ...pipelineAggregation(),
  ]);

  if (!messageWithSender[0]) throw new ApiError(500, 'Failed to fetch updated message');

  const messagePayload = messageWithSender[0];

  // Emit to all participants
  const io = req.app.get('io');
  if (io) {
    const reactionPayload = {
      chatId,
      messageId: messagePayload._id.toString(),
      reactions: messagePayload.reactions || [],
    };

    console.log('🎭 Emitting reaction:', reactionPayload);

    for (const participantId of chat.participants) {
      const participantIdStr = participantId.toString();
      const isOnline = isUserOnline(participantIdStr);

      console.log(`  → ${participantIdStr}: ${isOnline ? 'ONLINE ✅' : 'OFFLINE ❌'}`);

      if (isOnline) {
        io.to(`user:${participantIdStr}`).emit(
          SocketEventEnum.REACTION_RECEIVED_EVENT,
          reactionPayload
        );
      }
    }

    if (chat.lastMessage?.toString() === messageId) {
      const [chatPayload] = await chatModel.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(chatId) } },
        {
          $lookup: {
            from: 'users',
            localField: 'participants',
            foreignField: '_id',
            as: 'participants',
            pipeline: [{ $project: { password: 0, refreshToken: 0 } }],
          },
        },
        {
          $lookup: {
            from: 'chatmessages',
            localField: 'lastMessage',
            foreignField: '_id',
            as: 'lastMessage',
            pipeline: [
              {
                $lookup: {
                  from: 'users',
                  localField: 'sender',
                  foreignField: '_id',
                  as: 'sender',
                  pipeline: [{ $project: { username: 1, avatar: 1 } }],
                },
              },
              { $addFields: { sender: { $first: '$sender' } } },
            ],
          },
        },
        { $addFields: { lastMessage: { $first: '$lastMessage' } } },
      ]);

      if (chatPayload) {
        for (const participantId of chat.participants) {
          if (isUserOnline(participantId.toString())) {
            io.to(`user:${participantId}`).emit(
              SocketEventEnum.UPDATE_CHAT_LAST_MESSAGE_EVENT,
              chatPayload
            );
          }
        }
      }
    }
  }

  return new ApiResponse(200, 'Reaction updated', messagePayload);
});
export const replyToMessage = asyncHandler(async (req, res) => {
  const { chatId, messageId } = req.params;
  const { content, mentions = [] } = req.body;

  const chat = await chatModel.findById(chatId);
  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat not found');
  if (!chat.participants.includes(req.user._id))
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not a participant of this chat');

  // Handle attachments
  const attachments = [];
  if (req.files?.attachments?.length > 0) {
    req.files.attachments.forEach((attachment) => {
      attachments.push({
        url: getStaticFilePath(req, attachment.filename),
        localPath: getLocalFilePath(attachment.filename),
      });
    });
  }

  const parsedMentions = typeof mentions === 'string' ? JSON.parse(mentions) : mentions;

  // 1️⃣ Create reply message
  const message = await messageModel.create({
    content: content || '',
    sender: req.user._id,
    chat: chatId,
    replyId: messageId,
    attachments,
    mentions: Array.isArray(parsedMentions) ? parsedMentions : [],
  });

  // 2️⃣ Update lastMessage
  await chatModel.findByIdAndUpdate(chatId, {
    $set: { lastMessage: message._id },
  });

  // 3️⃣ Aggregate reply message
  const [messagePayload] = await messageModel.aggregate([
    { $match: { _id: message._id } },
    ...pipelineAggregation(),
  ]);

  if (!messagePayload)
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal server error');

  // 4️⃣ Aggregate updated chat
  const [chatPayload] = await chatModel.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(chatId) } },
    {
      $lookup: {
        from: 'users',
        localField: 'participants',
        foreignField: '_id',
        as: 'participants',
        pipeline: [{ $project: { password: 0, refreshToken: 0 } }],
      },
    },
    {
      $lookup: {
        from: 'chatmessages',
        localField: 'lastMessage',
        foreignField: '_id',
        as: 'lastMessage',
        pipeline: [
          {
            $lookup: {
              from: 'users',
              localField: 'sender',
              foreignField: '_id',
              as: 'sender',
              pipeline: [{ $project: { username: 1, avatar: 1 } }],
            },
          },
          { $addFields: { sender: { $first: '$sender' } } },
        ],
      },
    },
    { $addFields: { lastMessage: { $first: '$lastMessage' } } },
  ]);

  // 5️⃣ Notify participants (ONLINE + OFFLINE SAFE)
  const io = req.app.get('io');

  if (io) {
    // 🚚 Delivered logic (online + inside chat room)
    const deliveredNow = [];

    for (const participantId of chat.participants) {
      if (participantId.equals(req.user._id)) continue;

      const sockets = onlineUsers.get(participantId.toString());
      if (!sockets) continue;

      for (const socketId of sockets) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket?.rooms.has(`chat:${chatId}`)) {
          deliveredNow.push(participantId.toString());
          break;
        }
      }
    }

    if (deliveredNow.length) {
      await messageModel.findByIdAndUpdate(message._id, {
        $addToSet: { deliveredTo: { $each: deliveredNow.map((id) => id.toString()) } },
        $set: { status: 'delivered' },
      });

      messagePayload.status = 'delivered';
      messagePayload.deliveredTo = deliveredNow.map((id) => id.toString());

      await notifyChatParticipants({
        io,
        chat,
        actorId: req.user._id,
        event: SocketEventEnum.MESSAGE_DELIVERED_EVENT,
        payload: {
          chatId,
          messageId: message._id,
          deliveredTo: deliveredNow.map((id) => id.toString()),
        },
      });
    }

    await Promise.all([
      notifyChatParticipants({
        io,
        chat,
        actorId: req.user._id,
        event: SocketEventEnum.NEW_MESSAGE_RECEIVED_EVENT,
        payload: messagePayload,
      }),

      notifyChatParticipants({
        io,
        chat,
        actorId: req.user._id,
        event: SocketEventEnum.UPDATE_CHAT_LAST_MESSAGE_EVENT,
        payload: chatPayload,
      }),
    ]);
  }

  return new ApiResponse(StatusCodes.OK, 'Replied to message successfully', messagePayload);
});

export const markMessagesAsSeen = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user._id;

  const chat = await chatModel.findById(chatId);
  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat not found');

  const isParticipant = chat.participants.some((p) => p.equals(userId));
  if (!isParticipant) throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not a participant');

  // find messages first (so we can emit messageIds)
  const unseenMessages = await messageModel
    .find({
      chat: chatId,
      sender: { $ne: userId },
      seenBy: { $ne: userId },
    })
    .select('_id');

  if (unseenMessages.length === 0) {
    return new ApiResponse(StatusCodes.OK, 'No unseen messages');
  }

  const messageIds = unseenMessages.map((m) => m._id);

  await messageModel.updateMany(
    { _id: { $in: messageIds } },
    { $addToSet: { seenBy: userId, deliveredTo: userId }, $set: { status: 'seen' } }
  );

  const io = req.app.get('io');
  await notifyChatParticipants({
    io,
    chat,
    actorId: userId,
    event: SocketEventEnum.MESSAGE_SEEN_EVENT,
    payload: {
      chatId,
      seenBy: userId,
      messageIds,
    },
  });

  return new ApiResponse(StatusCodes.OK, 'Messages marked as seen');
});
