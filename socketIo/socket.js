import { ApiError } from "../utils/ApiError.js";
import { userModel } from "../models/index.js";
import { validateToken } from "../utils/jwt.js";
import { SocketEventEnum } from "../constants/constants.js";

const initializeSocket = (io) => {
  console.log(io);
  return io.on("connection", async (socket) => {
    try {
      const authorization = socket?.handshake?.auth ?? {};
      // Check for token in multiple possible locations
      const token = authorization.tokens?.accessToken;

      if (!token) {
        socket.emit(SocketEventEnum.SOCKET_ERROR_EVENT, "Authentication failed, Token is missing");
        socket.disconnect(true);
        return;
      }

      let decodedToken;
      try {
        decodedToken = validateToken(token, process.env.ACCESS_TOKEN_SECRET);
      } catch (tokenError) {
        console.error("❌ Token validation failed:", tokenError.message);
        socket.emit(SOCKET_EVENTS.SOCKET_ERROR_EVENT, "Authentication failed: Invalid token");
        socket.disconnect(true);
        return;
      }

      if (!decodedToken || !decodedToken._id) {
        console.error("❌ Invalid token payload");
        socket.emit(
          SOCKET_EVENTS.SOCKET_ERROR_EVENT,
          "Authentication failed: Invalid token payload"
        );
        socket.disconnect(true);
        return;
      }

      const user = await userModel
        .findById(decodedToken?._id)
        .select("-password -refreshToken -emailVerificationToken -emailVerificationExpiry");

      if (!user) {
        throw new ApiError(401, "Un-authorized handshake, Token is invalid", []);
      }

      socket.user = user;
      socket.userId = user?._id;
      socket.join(user?._id.toString());
      socket.emit(SocketEventEnum.CONNECTED_EVENT);

      console.log(`${user?._id} : joined connection`);
      console.log(`${user?.username} : joined connection`);

      mountTypingEvent(socket);
      unMountTypingEvent(socket);
      mountNewChatEvent(socket);
      mountJoinChatEvent(socket);

      socket.on("disconnect", (reason) => {
        console.log(`❌ User ${user.username} disconnected: ${reason}`);

        try {
          // Leave all rooms
          socket.leave(socket.userId);
        } catch (error) {
          console.error("❌ Error during disconnect cleanup:", error);
        }
      });

      socket.on(SocketEventEnum.DISCONNECT_EVENT, () => {
        console.log(`user disconnect from socket : ${socket.user?._id.toString()}`);
        if (socket.user?._id) {
          socket.leave(socket.user?._id);
        }

        socket.emit(SOCKET_EVENTS.DISCONNECTED_EVENT);
      });
    } catch (error) {
      socket.emit(
        SocketEventEnum.SOCKET_ERROR_EVENT,
        error?.message || "Something went wrong while connecting to the sockets"
      );
    }
  });
};

const mountJoinChatEvent = (socket) => {
  socket.on(SocketEventEnum.JOIN_CHAT_EVENT, (chatId) => {
    socket.join(chatId);
  });
};

const mountNewChatEvent = (req, event, payload, chatId) => {
  if (req.app.get("io")) {
    const io = req.app.get("io");
    return io.in(chatId).emit(event, payload);
  }
};

const mountTypingEvent = (socket) => {
  socket.on(SocketEventEnum.TYPING_EVENT, (data) => {
    console.log("start typing data: ", data);
    socket.in(data.chatId).emit(SocketEventEnum.TYPING_EVENT, data);
  });
};

const unMountTypingEvent = (socket) => {
  socket.on(SocketEventEnum.STOP_TYPING_EVENT, (data) => {
    console.log("stop typing data: ", data);
    socket.in(data.chatId).emit(SocketEventEnum.STOP_TYPING_EVENT, data);
  });
};
export { initializeSocket, mountNewChatEvent };
