// socketIo/socket.js
import { ApiError } from "../utils/ApiError.js";
import { chatModel, messageModel, userModel } from "../models/index.js";
import { validateToken } from "../utils/jwt.js";
import { SocketEventEnum } from "../constants/constants.js";
import redisClient from "../configs/redis.config.js";

const ONLINE_USERS_KEY = "online_users";
const USER_SOCKETS_PREFIX = "user_sockets:";
const PRESENCE_PREFIX = "presence:";

export const isUserOnline = async (userId) => {
  const exists = await redisClient.exists(
    `${PRESENCE_PREFIX}${userId.toString()}`,
  );
  return exists === 1;
};

export const getUserSockets = async (userId) => {
  return await redisClient.sMembers(
    `${USER_SOCKETS_PREFIX}${userId.toString()}`,
  );
};

// ✅ Simplified - just emit to online users, no queuing
export const notifyChatParticipants = async ({
  io,
  chat,
  actorId,
  event,
  payload,
}) => {
  for (const participantId of chat.participants) {
    // if (participantId.equals(actorId)) continue;

    const userId = participantId.toString();

    // Only emit if user is online
    io.to(`user:${userId}`).emit(event, payload);
  }
};

// ✅ Auto-deliver messages when user comes online
const autoDeliverMessages = async (socket, io) => {
  try {
    const userId = socket.user._id;

    // 1. Fetch all chat IDs the user is part of in one fast query
    const userChats = await chatModel
      .find({ participants: userId })
      .select("_id");
    if (userChats.length === 0) return;

    const chatIds = userChats.map((chat) => chat._id);

    // 2. Find ALL undelivered messages across ALL chats in a single DB query
    const undeliveredMessages = await messageModel
      .find({
        chat: { $in: chatIds },
        sender: { $ne: userId },
        deliveredTo: { $ne: userId },
        status: "sent",
      })
      .select("_id sender chat");

    if (undeliveredMessages.length === 0) return;

    const messageIds = undeliveredMessages.map((msg) => msg._id);

    // 3. Bulk update all messages at once
    await messageModel.updateMany(
      { _id: { $in: messageIds } },
      {
        $addToSet: { deliveredTo: userId },
        $set: { status: "delivered" },
      },
    );

    // 4. Group notifications by sender so we don't spam the network
    const messagesBySender = undeliveredMessages.reduce((acc, msg) => {
      const senderId = msg.sender.toString();
      if (!acc[senderId])
        acc[senderId] = { chatIds: new Set(), messageIds: [] };

      acc[senderId].chatIds.add(msg.chat.toString());
      acc[senderId].messageIds.push(msg._id.toString());
      return acc;
    }, {});

    // 5. Emit one aggregated message per active sender
    for (const [senderId, data] of Object.entries(messagesBySender)) {
      io.to(`user:${senderId}`).emit(SocketEventEnum.MESSAGE_DELIVERED_EVENT, {
        chatIds: Array.from(data.chatIds),
        messageIds: data.messageIds,
        deliveredTo: [userId.toString()],
        status: "delivered",
      });
    }

    console.log(
      `📬 Auto-delivered ${messageIds.length} messages to ${socket.user.username}`,
    );
  } catch (error) {
    console.error("❌ Auto-delivery error:", error);
  }
};

/**
 * Initialize socket connection
 */
const initializeSocket = (io) => {
  io.on("connection", async (socket) => {
    try {
      const authorization = socket?.handshake?.auth ?? {};
      const token = authorization.tokens?.accessToken;

      if (!token) {
        socket.emit(
          SocketEventEnum.SOCKET_ERROR_EVENT,
          "Authentication failed, Token is missing",
        );
        socket.disconnect(true);
        return;
      }

      let decodedToken;
      try {
        decodedToken = validateToken(token, process.env.ACCESS_TOKEN_SECRET);
      } catch (tokenError) {
        console.error("❌ Token validation failed:", tokenError.message);
        socket.emit(
          SocketEventEnum.SOCKET_ERROR_EVENT,
          "Authentication failed: Invalid token",
        );
        socket.disconnect(true);
        return;
      }

      if (!decodedToken?._id) {
        console.error("❌ Invalid token payload");
        socket.emit(
          SocketEventEnum.SOCKET_ERROR_EVENT,
          "Authentication failed: Invalid token payload",
        );
        socket.disconnect(true);
        return;
      }

      const user = await userModel
        .findById(decodedToken._id)
        .select(
          "-password -refreshToken -emailVerificationToken -emailVerificationExpiry",
        );

      if (!user) {
        throw new ApiError(401, "Unauthorized handshake: Token is invalid", []);
      }

      socket.user = user;
      const userId = socket.user._id.toString();

      socket.join(`user:${userId}`);

      // ✅ Listen for explicit USER_WENT_ONLINE_EVENT from client
      socket.on(SocketEventEnum.USER_WENT_ONLINE_EVENT, async () => {
        // Mark presence active for 30 seconds
        await redisClient.set(`${PRESENCE_PREFIX}${userId}`, "online", {
          EX: 30,
        });

        // Track this socket instance
        await redisClient.sAdd(`${USER_SOCKETS_PREFIX}${userId}`, socket.id);
        await redisClient.expire(`${USER_SOCKETS_PREFIX}${userId}`, 30); // Keep socket tracking synced

        console.log(`🟢 User went ONLINE: ${socket.user.username}`);

        // Broadcast to all users that this user is now online
        socket.broadcast.emit(SocketEventEnum.USER_ONLINE_EVENT, {
          userId: userId,
          username: socket.user.username,
        });

        // Auto-deliver undelivered messages
        await autoDeliverMessages(socket, io);
      });

      // TODO:
      socket.on("HEARTBEAT", async () => {
        const online = await isUserOnline(userId);
        if (online) {
          await redisClient.set(`${PRESENCE_PREFIX}${userId}`, "online", {
            EX: 30,
          });
          await redisClient.expire(`${USER_SOCKETS_PREFIX}${userId}`, 30);
        }
      });

      // ✅ Listen for explicit USER_WENT_OFFLINE_EVENT from client
      socket.on(SocketEventEnum.USER_WENT_OFFLINE_EVENT, async () => {
        await redisClient.sRem(`${USER_SOCKETS_PREFIX}${userId}`, socket.id);
        const remainingSockets = await redisClient.sCard(
          `${USER_SOCKETS_PREFIX}${userId}`,
        );

        if (remainingSockets === 0) {
          // Clear active keys immediately
          await redisClient.del(`${PRESENCE_PREFIX}${userId}`);
          await redisClient.del(`${USER_SOCKETS_PREFIX}${userId}`);

          socket.broadcast.emit(SocketEventEnum.USER_OFFLINE_EVENT, { userId });
          console.log(`🔴 User went OFFLINE: ${socket.user.username}`);
        }
      });

      // ✅ Allow clients to check if specific users are online
      socket.on(
        SocketEventEnum.CHECK_ONLINE_STATUS_EVENT,
        async ({ userIds }) => {
          const onlineStatuses = {};
          for (const userId of userIds) {
            onlineStatuses[userId] = await isUserOnline(userId);
          }

          socket.emit(
            SocketEventEnum.ONLINE_STATUS_RESPONSE_EVENT,
            onlineStatuses,
          );
        },
      );

      socket.emit(SocketEventEnum.CONNECTED_EVENT);
      console.log(`✅ User connected (socketId: ${socket.id})`);

      console.log("📍 Socket rooms:", Array.from(socket.rooms));

      // Mount events
      mountTypingEvent(socket);
      unMountTypingEvent(socket);
      mountJoinChatEvent(io, socket);
      mountLeaveChatEvent(io, socket);

      /**
       * Disconnect
       */
      socket.on("disconnect", async (reason) => {
        console.log(`❌ User ${user.username} disconnected: ${reason}`);

        await redisClient.sRem(`${USER_SOCKETS_PREFIX}${userId}`, socket.id);
        const remainingSockets = await redisClient.sCard(
          `${USER_SOCKETS_PREFIX}${userId}`,
        );

        if (remainingSockets === 0) {
          await redisClient.del(`${PRESENCE_PREFIX}${userId}`);
          await redisClient.del(`${USER_SOCKETS_PREFIX}${userId}`);

          socket.broadcast.emit(SocketEventEnum.USER_OFFLINE_EVENT, { userId });
          console.log(
            `🔴 User went offline via disconnect: ${socket.user.username}`,
          );
        }
        console.log(`🔴 User disconnected: ${userId}`);

        try {
          socket.leave(`user:${userId}`);
        } catch (error) {
          console.error("❌ Error during disconnect cleanup:", error);
        }
      });
    } catch (error) {
      socket.emit(
        SocketEventEnum.SOCKET_ERROR_EVENT,
        error?.message || "Socket connection failed",
      );
    }
  });
};

/**
 * 🚪 LEAVE_CHAT_EVENT
 */
const mountLeaveChatEvent = (io, socket) => {
  socket.on(SocketEventEnum.LEAVE_CHAT_EVENT, async ({ chatId }) => {
    try {
      const userId = socket.user._id;

      const chat = await chatModel.findById(chatId).select("participants");
      if (!chat) return;

      const isParticipant = chat.participants.some((p) => p.equals(userId));

      if (!isParticipant) {
        console.log("❌ Unauthorized LEAVE_CHAT_EVENT attempt");
        return;
      }

      // 1️⃣ Leave chat room
      socket.leave(`chat:${chatId}`);

      console.log(`🚪 User ${socket.user.username} left chat ${chatId}`);
    } catch (error) {
      console.error("❌ LEAVE_CHAT_EVENT error:", error);
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

      const chat = await chatModel.findById(chatId).select("participants");
      if (!chat) return;

      const isParticipant = chat.participants.some((participantId) =>
        participantId.equals(userId),
      );

      if (!isParticipant) {
        console.log("❌ Unauthorized JOIN_CHAT_EVENT attempt");
        return;
      }

      // 1️⃣ Join the socket room layout
      socket.join(`chat:${chatId}`);
      console.log(
        `✅ User ${socket.user.username} joined chat room: ${chatId}`,
      );

      // 2️⃣ Auto-mark unseen messages as seen
      const unseenMessages = await messageModel
        .find({
          chat: chatId,
          sender: { $ne: userId },
          seenBy: { $ne: userId },
        })
        .select("_id sender");

      if (unseenMessages.length > 0) {
        const messageIds = unseenMessages.map((msg) => msg._id);

        // Bulk update database records
        await messageModel.updateMany(
          { _id: { $in: messageIds } },
          {
            $addToSet: { seenBy: userId, deliveredTo: userId },
            $set: { status: "seen" },
          },
        );

        // Unify sender notification targets
        const senderIds = [
          ...new Set(unseenMessages.map((m) => m.sender.toString())),
        ];

        // 🚀 OPTIMIZATION: Emit to rooms directly. Socket.io safely drops events for disconnected users.
        for (const senderId of senderIds) {
          io.to(`user:${senderId}`).emit(SocketEventEnum.MESSAGE_SEEN_EVENT, {
            chatId,
            messageIds,
            seenBy: userId.toString(),
            status: "seen",
          });
        }

        console.log(
          `👁️ Auto-marked ${messageIds.length} messages as seen for ${socket.user.username}`,
        );
      }
    } catch (err) {
      console.error("❌ JOIN_CHAT_EVENT error:", err);
    }
  });
};

/**
 * Mount a generic event to emit to a specific room
 */
const mountNewChatEvent = (req, event, payload, roomId) => {
  const io = req.app.get("io");
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
      console.log("⚠️ TYPING_EVENT: socket not in chat room");
      return;
    }

    console.log("⌨️ TYPING_EVENT broadcasting:", payload);
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
      console.log("⚠️ STOP_TYPING_EVENT: socket not in chat room");
      return;
    }

    console.log("⏹️ STOP_TYPING_EVENT broadcasting:", payload);
    socket
      .to(`chat:${chatId}`)
      .emit(SocketEventEnum.STOP_TYPING_EVENT, payload);
  });
};

export {
  mountJoinChatEvent,
  mountNewChatEvent,
  mountTypingEvent,
  unMountTypingEvent,
  initializeSocket,
};
