import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { chatModel, messageModel } from '../../models/index.js';
import {
  getLocalFilePath,
  getStaticFilePath,
  removeLocalFile,
  removeUnusedMulterFilesOnError,
} from '../../helper.js';
import mongoose from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { SocketEventEnum } from '../../constants/constants.js';
import { getUserSockets, isUserOnline, notifyChatParticipants } from '../../socketIo/socket.js';
import {
  deleteFileFromCloudinary,
  uploadFileToCloudinary,
} from '../../configs/cloudinary.config.js';
import { getOrSetCache, invalidateCache } from '../../utils/cache.js';

const mode = process.env.NODE_ENV;

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
        'polling.options': {
          $map: {
            input: { $ifNull: ['$polling.options', []] },
            as: 'option',
            in: {
              optionValue: '$$option.optionValue',
              _id: '$$option._id',
              // We will populate these IDs in the next step
              responses: '$$option.responses',
            },
          },
        },
      },
    },
    // We lookup all users who have voted in any of the options at once for performance
    {
      $lookup: {
        from: 'users',
        let: {
          allVoterIds: {
            $reduce: {
              input: '$polling.options.responses',
              initialValue: [],
              in: { $setUnion: ['$$value', '$$this'] },
            },
          },
        },
        pipeline: [
          {
            $match: {
              $expr: { $in: ['$_id', '$$allVoterIds'] },
            },
          },
          { $project: { _id: 1, username: 1, avatar: 1 } },
        ],
        as: 'voterObjects',
      },
    },
    {
      $addFields: {
        'polling.options': {
          $map: {
            input: '$polling.options',
            as: 'option',
            in: {
              _id: '$$option._id',
              optionValue: '$$option.optionValue',
              // Map the responses IDs to the full user objects we just looked up
              responses: {
                $map: {
                  input: '$$option.responses',
                  as: 'voterId',
                  in: {
                    $first: {
                      $filter: {
                        input: '$voterObjects',
                        as: 'voter',
                        cond: { $eq: ['$$voter._id', '$$voterId'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      $addFields: {
        repliedMessage: { $first: '$repliedMessage' },
        status: { $ifNull: ['$status', 'sent'] },
        deliveredTo: { $ifNull: ['$deliveredTo', []] },
        seenBy: { $ifNull: ['$seenBy', []] },
      },
    },
    {
      $project: {
        reactionUsers: 0,
        voterObjects: 0,
      },
    },
  ];
};

export const getAllChats = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const cacheKey = `chat_messages:${chatId}`;

  const messageData = await getOrSetCache(cacheKey, async () => {
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

    return { chatId, messages } || [];
  });

  return new ApiResponse(200, 'Messages fetched successfully', messageData);
});

export const toggleVoteToPollingVote = asyncHandler(async (req, res) => {
  const { chatId, messageId, optionId } = req.params; // Use messageId for accuracy
  const userId = req.user._id;

  const message = await messageModel.findById(messageId);
  if (!message || message.contentType !== 'polling') {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Poll not found');
  }

  const allowMultiple = message.polling.allowMultipleAnswer;

  // 1. Find the target option
  const targetOption = message.polling.options.find((opt) => opt._id.toString() === optionId);
  if (!targetOption) throw new ApiError(StatusCodes.NOT_FOUND, 'Option not found');

  const hasVotedForThis = targetOption.responses.some((id) => id.equals(userId));

  if (hasVotedForThis) {
    // 2. Un-vote (always allowed)
    targetOption.responses = targetOption.responses.filter((id) => !id.equals(userId));
  } else {
    // 3. Add vote
    // If multiple answers are NOT allowed, remove user from all other options first
    if (!allowMultiple) {
      message.polling.options.forEach((opt) => {
        opt.responses = opt.responses.filter((id) => !id.equals(userId));
      });
    }
    targetOption.responses.push(userId);
  }

  await message.save();
  invalidateCache(`chat_messages:${chatId}`);

  const [messagePayload] = await messageModel.aggregate([
    { $match: { _id: message._id } },
    ...pipelineAggregation(),
  ]);

  console.log(messagePayload);

  // 3. Emit a specific VOTE_UPDATE event so everyone's UI updates live
  const io = req.app.get('io');
  if (io) {
    io.to(`chat:${chatId}`).emit(SocketEventEnum.POLL_VOTE_UPDATED, {
      messageId: messagePayload._id,
      options: messagePayload.polling.options, // Send updated options list
    });
  }

  return new ApiResponse(StatusCodes.OK, 'Vote updated', message.polling.options);
});

export const createPollingVote = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { questionTitle, options = [], allowMultipleAnswer } = req.body;

  const userId = req.user._id;

  const chat = await chatModel.findById(chatId);
  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat not found');

  if (!options || options.length < 2) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'A poll must have at least two options');
  }

  const createdPollingVoteMessage = await messageModel.create({
    content: '',
    contentType: 'polling',
    sender: userId,
    chat: chatId,
    attachments: [],
    mentions: [],
    deliveredTo: [],
    seenBy: [],
    polling: {
      questionTitle,
      allowMultipleAnswer: Boolean(allowMultipleAnswer),
      options,
    },
  });

  await chatModel.findByIdAndUpdate(chatId, {
    $set: { lastMessage: createdPollingVoteMessage._id },
  });

  const [messagePayload] = await messageModel.aggregate([
    { $match: { _id: createdPollingVoteMessage._id } },
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
        pipeline: [
          {
            $project: {
              password: 0,
              refreshToken: 0,
            },
          },
        ],
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
    const messageId = createdPollingVoteMessage._id;

    for (const participantId of chat.participants) {
      if (participantId.equals(req.user._id)) continue;

      const sockets = await getUserSockets(participantId.toString());
      if (!sockets || sockets.length === 0) continue;

      for (const socketId of sockets) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket?.rooms.has(`chat:${chatId}`)) {
          deliveredNow.push(participantId.toString());
          break;
        }
      }
    }

    if (deliveredNow.length) {
      await messageModel.findByIdAndUpdate(messageId, {
        $addToSet: {
          deliveredTo: {
            $each: deliveredNow.map((id) => id.toString()),
          },
        },
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
          messageId: createdPollingVoteMessage._id,
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

    // Invalidate caches
    invalidateCache(`chat_messages:${chatId}`);
    chat.participants.forEach((participantId) => {
      invalidateCache(`user_chats:${participantId}`);
    });
  }

  return new ApiResponse(StatusCodes.CREATED, 'Poll created successfully', {});
});

export const createMessage = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { content, mentions = [], audioDuration } = req.body;

  const chat = await chatModel.findById(chatId);
  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat not found');
  if (!chat.participants.includes(req.user._id))
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not a participant of this chat');

  // Handle attachments
  const attachments = [];

  if (req.files?.attachments?.length > 0) {
    const isProduction = mode === 'production';

    for (const attachment of req.files.attachments) {
      let fileType = 'document';
      let category = 'documents';

      if (attachment.mimetype.startsWith('image/')) {
        fileType = 'image';
        category = 'images';
      } else if (attachment.mimetype.startsWith('video/')) {
        fileType = 'video';
        category = 'videos';
      } else if (attachment.mimetype.startsWith('audio/')) {
        fileType = 'voice';
        category = 'voices';
      }

      let finalUrl = '';
      let publicId = null;

      try {
        if (isProduction) {
          // PRODUCTION: Upload to Cloudinary using file path (NOT buffer)
          const uploadResult = await uploadFileToCloudinary(
            attachment.path,
            `${process.env.CLOUDINARY_BASE_FOLDER}/${category}`,
          );
          finalUrl = uploadResult.secure_url;
          publicId = uploadResult.public_id;

          // CLEANUP: Remove local file after successful cloud upload
          removeLocalFile(attachment.path);
        } else {
          // DEVELOPMENT: Use local path for offline access
          finalUrl = getStaticFilePath(req, category, attachment.filename);
        }

        attachments.push({
          fileType,
          fileName: attachment.originalname,
          fileSize: attachment.size,
          url: finalUrl,
          public_id: publicId,
          // Store localPath in dev for database reference if needed
          localPath: isProduction ? null : getLocalFilePath(category, attachment.filename),
          duration: fileType === 'voice' ? parseInt(audioDuration) || 0 : 0,
        });
      } catch (error) {
        // SAFETY: Cleanup all files if any single upload fails to prevent junk on disk
        removeUnusedMulterFilesOnError(req);
        throw new ApiError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          'File processing failed: ' + error.message,
        );
      }
    }
  }

  const parsedMentions = typeof mentions === 'string' ? JSON.parse(mentions) : mentions;

  // 1️⃣ Create message
  const message = await messageModel.create({
    content: content || '',
    contentType: 'text-file',
    sender: req.user._id,
    chat: chatId,
    attachments,
    mentions: Array.isArray(parsedMentions) ? parsedMentions : [],
    deliveredTo: [],
    seenBy: [],
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

      const sockets = await getUserSockets(participantId.toString());
      if (!sockets || sockets.length === 0) continue;

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

    // Invalidate caches
    invalidateCache(`chat_messages:${chatId}`);
    chat.participants.forEach((participantId) => {
      invalidateCache(`user_chats:${participantId}`);
    });
  }

  return new ApiResponse(StatusCodes.OK, 'Message created successfully', messagePayload);
});

export const deleteChatMessage = asyncHandler(async (req, res) => {
  const { messageId, chatId } = req.params;

  const chat = await chatModel.findById(chatId);
  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat not found');

  const message = await messageModel.findOne({ chat: chat._id, _id: messageId });
  if (!message) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat message not found');

  if (mode === 'production') {
    message.attachments.forEach(async (file) => await deleteFileFromCloudinary(file.public_id));
  } else {
    message.attachments.forEach((file) => removeLocalFile(file.localPath));
  }

  console.log(message.attachments.forEach((file) => removeLocalFile(file.localPath)));

  const updatedMessage = await messageModel.findOneAndUpdate(
    { _id: messageId, chat: chatId },
    { $set: { isDeleted: true } },
    { new: true },
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

  // Invalidate caches
  invalidateCache(`chat_messages:${chatId}`);
  chat.participants.forEach((participantId) => {
    invalidateCache(`user_chats:${participantId}`);
  });

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

  const existingReactions = [...chatMessage.reactions] || [];

  // 🔹 Step 1: Check if user previously reacted with this SAME emoji
  const userPreviouslyUsedThisEmoji = existingReactions.some(
    (reaction) =>
      reaction.emoji === emoji &&
      reaction.userIds.some((id) => id.toString() === userId.toString()),
  );

  // 🔹 Step 2: Remove user from ALL reactions (user can only have one reaction)
  let updatedReactions = existingReactions
    .map((reaction) => {
      const reactionDoc = reaction._doc || reaction;
      return {
        ...reactionDoc,
        userIds: reactionDoc.userIds.filter((id) => id.toString() !== userId.toString()),
      };
    })
    .filter((reaction) => reaction.userIds.length > 0); // Remove empty reactions

  // 🔹 Step 3: Consolidate duplicate emojis (this is the key fix!)
  const emojiMap = new Map();

  for (const reaction of updatedReactions) {
    const reactionDoc = reaction._doc || reaction;
    const emojiKey = reactionDoc.emoji;

    if (emojiMap.has(emojiKey)) {
      // Merge userIds into existing emoji
      const existing = emojiMap.get(emojiKey);
      reactionDoc.userIds.forEach((userId) => {
        const userIdStr = userId.toString();
        if (!existing.userIds.some((id) => id.toString() === userIdStr)) {
          existing.userIds.push(userId);
        }
      });
    } else {
      // New emoji
      emojiMap.set(emojiKey, {
        emoji: emojiKey,
        userIds: [...reactionDoc.userIds],
        messageId: reactionDoc.messageId || messageId,
      });
    }
  }

  updatedReactions = Array.from(emojiMap.values());

  // 🔹 Step 4: If NOT toggling off, add the user's reaction
  if (!userPreviouslyUsedThisEmoji) {
    const existingEmojiIndex = updatedReactions.findIndex((r) => r.emoji === emoji);

    if (existingEmojiIndex !== -1) {
      // Emoji exists, add user to it
      if (
        !updatedReactions[existingEmojiIndex].userIds.some(
          (id) => id.toString() === userId.toString(),
        )
      ) {
        updatedReactions[existingEmojiIndex].userIds.push(userId);
      }
    } else {
      // New emoji, create it
      updatedReactions.push({
        emoji,
        userIds: [userId],
        messageId,
      });
    }
  }

  // Update the message in database
  const updatedMessage = await messageModel.findByIdAndUpdate(
    messageId,
    { $set: { reactions: updatedReactions } },
    { new: true },
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

    for (const participantId of chat.participants) {
      const participantIdStr = participantId.toString();
      const isOnline = await isUserOnline(participantIdStr);

      if (isOnline) {
        io.to(`user:${participantIdStr}`).emit(
          SocketEventEnum.REACTION_RECEIVED_EVENT,
          reactionPayload,
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
          if (await isUserOnline(participantId.toString())) {
            io.to(`user:${participantId}`).emit(
              SocketEventEnum.UPDATE_CHAT_LAST_MESSAGE_EVENT,
              chatPayload,
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
  const { content, mentions = [], audioDuration } = req.body;

  const chat = await chatModel.findById(chatId);
  if (!chat) throw new ApiError(StatusCodes.NOT_FOUND, 'Chat not found');
  if (!chat.participants.includes(req.user._id))
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not a participant of this chat');

  // Handle attachments
  const attachments = [];

  if (req.files?.attachments?.length > 0) {
    const isProduction = mode === 'production';

    for (const attachment of req.files.attachments) {
      let fileType = 'document';
      let category = 'documents';

      if (attachment.mimetype.startsWith('image/')) {
        fileType = 'image';
        category = 'images';
      } else if (attachment.mimetype.startsWith('video/')) {
        fileType = 'video';
        category = 'videos';
      } else if (attachment.mimetype.startsWith('audio/')) {
        fileType = 'voice';
        category = 'voices';
      }

      let finalUrl = '';
      let publicId = null;

      try {
        if (isProduction) {
          // PRODUCTION: Upload to Cloudinary using file path (NOT buffer)
          const uploadResult = await uploadFileToCloudinary(
            attachment.path,
            `${process.env.CLOUDINARY_BASE_FOLDER}/${category}`,
          );
          finalUrl = uploadResult.secure_url;
          publicId = uploadResult.public_id;

          // CLEANUP: Remove local file after successful cloud upload
          removeLocalFile(attachment.path);
        } else {
          // DEVELOPMENT: Use local path for offline access
          finalUrl = getStaticFilePath(req, category, attachment.filename);
        }

        attachments.push({
          fileType,
          fileName: attachment.originalname,
          fileSize: attachment.size,
          url: finalUrl,
          public_id: publicId,
          // Store localPath in dev for database reference if needed
          localPath: isProduction ? null : getLocalFilePath(category, attachment.filename),
          duration: fileType === 'voice' ? parseInt(audioDuration) || 0 : 0,
        });
      } catch (error) {
        // SAFETY: Cleanup all files if any single upload fails to prevent junk on disk
        removeUnusedMulterFilesOnError(req);
        throw new ApiError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          'File processing failed: ' + error.message,
        );
      }
    }
  }

  const parsedMentions = typeof mentions === 'string' ? JSON.parse(mentions) : mentions;

  // 1️⃣ Create reply message
  const message = await messageModel.create({
    content: content || '',
    sender: req.user._id,
    chat: chatId,
    replyId: messageId,
    contentType: 'text-file',
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

      const sockets = await getUserSockets(participantId.toString());
      if (!sockets || sockets.length === 0) continue;

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
    { $addToSet: { seenBy: userId, deliveredTo: userId }, $set: { status: 'seen' } },
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

  invalidateCache(`chat_messages:${chatId}`);

  return new ApiResponse(StatusCodes.OK, 'Messages marked as seen');
});
