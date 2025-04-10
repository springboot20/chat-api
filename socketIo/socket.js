import { ApiError } from '../utils/ApiError.js';
import { userModel } from '../models/index.js';
import { validateToken } from '../utils/jwt.js';
import { SocketEventEnum } from '../constants/constants.js';

const initializeSocket = (io) => {
  return io.on('connection', async (socket) => {
    console.log('socket connected');

    const authorization = socket?.handshake?.auth;

    try {
      if (!authorization.token) {
        throw new ApiError(401, 'Un-authentication failed, Token is invalid', []);
      }

      let authDecodedToken = validateToken(authorization.token, process.env.ACCESS_TOKEN_SECRET);

      let dToken = authDecodedToken;

      const user = await userModel
        .findById(dToken?._id)
        .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

      if (!user) {
        throw new ApiError(401, 'Un-authorized handshake, Token is invalid', []);
      }

      socket.user = user;
      socket.join(user?._id.toString());
      socket.emit(SocketEventEnum.CONNECTED_EVENT);

      console.log(`${socket?.user?._id}  joined connection`);

      mountTypingEvent(socket);
      unMountTypingEvent(socket);
      mountNewChatEvent(socket);
      mountJoinChatEvent(socket);

      socket.on(SocketEventEnum.DISCONNECT_EVENT, () => {
        console.log(`user disconnect from socket : ${socket.user?._id.toString()}`);
        if (socket.user?._id) {
          socket.leave(socket.user?._id);
        }
      });
    } catch (error) {
      socket.emit(
        SocketEventEnum.SOCKET_ERROR_EVENT,
        error?.message || 'Something went wrong while connecting to the sockets'
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
  return req.app.get('io').in(chatId).emit(event, payload);
};

const mountTypingEvent = (socket) => {
  socket.on(SocketEventEnum.TYPING_EVENT, (chatId) => {
    socket.in(chatId).emit(SocketEventEnum.TYPING_EVENT, chatId);
  });
};

const unMountTypingEvent = (socket) => {
  socket.on(SocketEventEnum.STOP_TYPING_EVENT, (chatId) => {
    socket.in(chatId).emit(SocketEventEnum.STOP_TYPING_EVENT, chatId);
  });
};
export { initializeSocket, mountNewChatEvent };
