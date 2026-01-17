// socketIo/socket.js
import { ApiError } from '../utils/ApiError.js';
import { chatModel, messageModel, userModel } from '../models/index.js';
import { validateToken } from '../utils/jwt.js';
import { SocketEventEnum } from '../constants/constants.js';

export const onlineUsers = new Map();

export const isUserOnline = (userId) => {
  return onlineUsers.has(userId.toString());
};

// ✅ Simplified - just emit to online users, no queuing
export const notifyChatParticipants = async ({ io, chat, actorId, event, payload }) => {
  for (const participantId of chat.participants) {
    // if (participantId.equals(actorId)) continue;

    const userId = participantId.toString();

    // Only emit if user is online
    if (isUserOnline(userId)) {
      io.to(`user:${userId}`).emit(event, payload);
    } else {
      console.log(`📭 User ${userId} is offline, event not sent: ${event}`);
    }
  }
};

// ✅ Auto-deliver messages when user comes online
const autoDeliverMessages = async (socket, io) => {
  try {
    const userId = socket.user._id;

    // Find all chats this user is part of
    const userChats = await chatModel
      .find({
        participants: userId,
      })
      .select('_id participants');

    for (const chat of userChats) {
      // Find undelivered messages in this chat (sent by others)
      const undeliveredMessages = await messageModel
        .find({
          chat: chat._id,
          sender: { $ne: userId },
          deliveredTo: { $ne: userId },
          status: { $in: ['sent'] },
        })
        .select('_id sender');

      if (undeliveredMessages.length === 0) continue;

      const messageIds = undeliveredMessages.map((msg) => msg._id);

      // Mark as delivered
      await messageModel.updateMany(
        { _id: { $in: messageIds } },
        {
          $addToSet: { deliveredTo: userId },
          $set: { status: 'delivered' },
        }
      );

      // Notify each sender that their message was delivered
      const senderIds = [...new Set(undeliveredMessages.map((m) => m.sender.toString()))];

      for (const senderId of senderIds) {
        const senderMessages = messageIds.filter(
          (msgId, idx) => undeliveredMessages[idx].sender.toString() === senderId
        );

        io.to(`user:${senderId}`).emit(SocketEventEnum.MESSAGE_DELIVERED_EVENT, {
          chatId: chat._id,
          messageIds: senderMessages,
          deliveredTo: [userId.toString()],
          status: 'delivered',
        });
      }

      console.log(`📬 Auto-delivered ${messageIds.length} messages to ${socket.user.username}`);
    }
  } catch (error) {
    console.error('❌ Auto-delivery error:', error);
  }
};

/**
 * Initialize socket connection
 */
const initializeSocket = (io) => {
  io.on('connection', async (socket) => {
    try {
      const authorization = socket?.handshake?.auth ?? {};
      const token = authorization.tokens?.accessToken;

      if (!token) {
        socket.emit(SocketEventEnum.SOCKET_ERROR_EVENT, 'Authentication failed, Token is missing');
        socket.disconnect(true);
        return;
      }

      let decodedToken;
      try {
        decodedToken = validateToken(token, process.env.ACCESS_TOKEN_SECRET);
      } catch (tokenError) {
        console.error('❌ Token validation failed:', tokenError.message);
        socket.emit(SocketEventEnum.SOCKET_ERROR_EVENT, 'Authentication failed: Invalid token');
        socket.disconnect(true);
        return;
      }

      if (!decodedToken?._id) {
        console.error('❌ Invalid token payload');
        socket.emit(
          SocketEventEnum.SOCKET_ERROR_EVENT,
          'Authentication failed: Invalid token payload'
        );
        socket.disconnect(true);
        return;
      }

      const user = await userModel
        .findById(decodedToken._id)
        .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

      if (!user) {
        throw new ApiError(401, 'Unauthorized handshake: Token is invalid', []);
      }

      socket.user = user;

      // ✅ Listen for explicit USER_WENT_ONLINE_EVENT from client
      socket.on(SocketEventEnum.USER_WENT_ONLINE_EVENT, async () => {
        const userId = socket.user._id.toString();

        if (!onlineUsers.has(userId)) {
          onlineUsers.set(userId, new Set());
        }

        onlineUsers.get(userId).add(socket.id);

        console.log(`🟢 User went ONLINE: ${socket.user.username}`);
        console.log('🟢 Online users:', Array.from(onlineUsers.keys()));

        // Broadcast to all users that this user is now online
        socket.broadcast.emit(SocketEventEnum.USER_ONLINE_EVENT, {
          userId: userId,
          username: socket.user.username,
        });

        // Auto-deliver undelivered messages
        await autoDeliverMessages(socket, io);
      });

      // ✅ Listen for explicit USER_WENT_OFFLINE_EVENT from client
      socket.on(SocketEventEnum.USER_WENT_OFFLINE_EVENT, () => {
        const userId = socket.user._id.toString();

        if (onlineUsers.has(userId)) {
          onlineUsers.get(userId).delete(socket.id);

          if (onlineUsers.get(userId).size === 0) {
            onlineUsers.delete(userId);

            // Broadcast to all users that this user is now offline
            socket.broadcast.emit(SocketEventEnum.USER_OFFLINE_EVENT, {
              userId: userId,
            });

            console.log(`🔴 User went OFFLINE: ${socket.user.username}`);
            console.log('🟢 Online users:', Array.from(onlineUsers.keys()));
          }
        }
      });

      // ✅ Allow clients to check if specific users are online
      socket.on(SocketEventEnum.CHECK_ONLINE_STATUS_EVENT, ({ userIds }) => {
        const onlineStatuses = {};
        userIds.forEach((userId) => {
          onlineStatuses[userId] = isUserOnline(userId);
        });

        socket.emit(SocketEventEnum.ONLINE_STATUS_RESPONSE_EVENT, onlineStatuses);
      });

      socket.join(`user:${user._id.toString()}`);
      socket.emit(SocketEventEnum.CONNECTED_EVENT);

      console.log('✅ User connected (socket):', {
        userId: user._id.toString(),
        username: user.username,
        socketId: socket.id,
      });

      console.log('📍 Socket rooms:', Array.from(socket.rooms));

      // Mount events
      mountTypingEvent(socket);
      unMountTypingEvent(socket);
      mountJoinChatEvent(io, socket);

      /**
       * Disconnect
       */
      socket.on('disconnect', (reason) => {
        console.log(`❌ User ${user.username} disconnected: ${reason}`);
        const userId = socket.user?._id.toString();

        if (userId && onlineUsers.has(userId)) {
          onlineUsers.get(userId).delete(socket.id);

          if (onlineUsers.get(userId).size === 0) {
            onlineUsers.delete(userId);

            // Broadcast offline status
            socket.broadcast.emit(SocketEventEnum.USER_OFFLINE_EVENT, {
              userId: userId,
            });

            console.log(`🔴 User went offline (disconnect): ${socket.user.username}`);
          }
        }

        console.log(`🔴 User disconnected: ${userId}`);
        console.log('🟢 Online users:', Array.from(onlineUsers.keys()));

        try {
          socket.leave(`user:${userId}`);
        } catch (error) {
          console.error('❌ Error during disconnect cleanup:', error);
        }
      });
    } catch (error) {
      socket.emit(SocketEventEnum.SOCKET_ERROR_EVENT, error?.message || 'Socket connection failed');
    }
  });
};

/**
 * ✅ JOIN_CHAT_EVENT
 */
const mountJoinChatEvent = (io, socket) => {
  socket.on(SocketEventEnum.JOIN_CHAT_EVENT, async ({ chatId }) => {
    try {
      const userId = socket.user._id;

      const chat = await chatModel.findById(chatId);
      if (!chat) return;

      const isParticipant = chat?.participants.some((participantId) =>
        participantId.equals(userId)
      );

      if (!isParticipant) {
        console.log('❌ Unauthorized JOIN_CHAT_EVENT attempt');
        return;
      }

      // 1️⃣ Join chat room
      socket.join(`chat:${chatId}`);
      console.log(`✅ User ${socket.user.username} joined chat ${chatId}`);

      // 2️⃣ Auto-mark unseen messages as seen
      const unseenMessages = await messageModel
        .find({
          chat: chatId,
          sender: { $ne: userId },
          seenBy: { $ne: userId },
        })
        .select('_id sender');

      if (unseenMessages.length > 0) {
        const messageIds = unseenMessages.map((msg) => msg._id);

        // Mark as seen
        await messageModel.updateMany(
          { _id: { $in: messageIds } },
          {
            $addToSet: {
              seenBy: userId,
              deliveredTo: userId,
            },
            $set: { status: 'seen' },
          }
        );

        // Notify senders (blue checkmarks)
        const senderIds = [...new Set(unseenMessages.map((m) => m.sender.toString()))];

        for (const senderId of senderIds) {
          // Only notify if sender is online
          if (isUserOnline(senderId)) {
            io.to(`user:${senderId}`).emit(SocketEventEnum.MESSAGE_SEEN_EVENT, {
              chatId,
              messageIds,
              seenBy: userId.toString(),
              status: 'seen',
            });
          }
        }

        console.log(
          `👁️ Auto-marked ${messageIds.length} messages as seen for ${socket.user.username}`
        );
      }
    } catch (err) {
      console.error('JOIN_CHAT_EVENT error:', err);
    }
  });
};

/**
 * Mount a generic event to emit to a specific room
 */
const mountNewChatEvent = (req, event, payload, roomId) => {
  const io = req.app.get('io');
  if (io) io.to(roomId).emit(event, payload);
};

/**
 * TYPING_EVENT
 */
const mountTypingEvent = (socket) => {
  socket.on(SocketEventEnum.TYPING_EVENT, (chatId) => {
    const payload = {
      chatId,
      userId: socket.user._id.toString(),
      username: socket.user.username,
    };

    if (!socket.rooms.has(`chat:${chatId}`)) {
      console.log('⚠️ TYPING_EVENT: socket not in chat room');
      return;
    }

    console.log('⌨️ TYPING_EVENT broadcasting:', payload);
    socket.to(`chat:${chatId}`).emit(SocketEventEnum.TYPING_EVENT, payload);
  });
};

/**
 * STOP_TYPING_EVENT
 */
const unMountTypingEvent = (socket) => {
  socket.on(SocketEventEnum.STOP_TYPING_EVENT, (chatId) => {
    const payload = {
      chatId,
      userId: socket.user._id.toString(),
      username: socket.user.username,
    };

    if (!socket.rooms.has(`chat:${chatId}`)) {
      console.log('⚠️ STOP_TYPING_EVENT: socket not in chat room');
      return;
    }

    console.log('⏹️ STOP_TYPING_EVENT broadcasting:', payload);
    socket.to(`chat:${chatId}`).emit(SocketEventEnum.STOP_TYPING_EVENT, payload);
  });
};

export { initializeSocket, mountNewChatEvent };
