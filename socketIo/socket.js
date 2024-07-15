import { ApiError } from '../utils/ApiError.js';
import { userModel } from '../models/index.js';
import { validateToken } from '../utils/jwt.js';
import { SocketEventEnum } from '../constants/constants.js';
import cookie from 'cookie';

const initializeSocket = (io) => {
  return io.on('connection', async (socket) => {
    try {
      const authorization = socket.handshake?.headers?.authorization;
      const cookies = cookie.parse(socket.handshake?.headers?.cookies);

      let cookieToken = cookies?.accessToken;

      if (!authorization || !authorization.startsWith('Bearer')) {
        throw new ApiError(401, 'Un-authentication failed, Token is invalid', []);
      }template

      let authToken = authorization.split(' ')[1];

      if (!cookieToken) {
        cookieToken = socket.handshake.auth?.cookieToken;
      }

      if (!authToken) {
        authToken = socket.handshake.auth?.authToken;
      }

      if (!cookieToken || !authToken) {
        throw new ApiError(401, 'Un-authorized handshake, Token is invalid', []);
      }

      let authDecodedToken = validateToken(authToken, process.env.ACCESS_TOKEN_SECRET);
      let cookieDecodedToken = validateToken(cookieToken, process.env.SESSION_SECRET);

      let dToken = authDecodedToken || cookieDecodedToken;

      const user = await userModel.findById(dToken?._id).select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

      if (!user) {
        throw new ApiError(401, 'Un-authorized handshake, Token is invalid', []);
      }

      socket.user = user;
      socket.join(user?._id.toString());
      socket.emit(SocketEventEnum.CONNECTED_EVENT);

      console.log(socket.id);
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
      socket.emit(SocketEventEnum.SOCKET_ERROR_EVENT, error?.message || 'Something went wrong while connecting to the sockets');
    }
  });
};

const mountJoinChatEvent = (socket) => {
  socket.on(SocketEventEnum.JOIN_CHAT_EVENT, (chatId) => {
    socket.join(chatId);
  });
};

const mountNewChatEvent = (req, event, payload, chatId) => {
  req.app.get('io').in(chatId).emit(event, payload);
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
