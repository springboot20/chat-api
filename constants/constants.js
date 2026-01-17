export const UserRoles = {
  USER: 'USER',
  ADMIN: 'ADMIN',
};

export const AvailableUserRole = Object.values(UserRoles);

export const LoginType = {
  EMAIL_PASSWORD: 'EMAIL_PASSWORD',
  GOOGLE: 'GOOGLE',
};

export const AvailableLoginType = Object.values(LoginType);

export const SocketEventEnum = {
  JOIN_CHAT_EVENT: 'joinChat',
  CONNECTED_EVENT: 'connected',
  DISCONNECT_EVENT: 'disconnect',
  DISCONNECTED_EVENT: 'disconnected',
  NEW_MESSAGE_RECEIVED_EVENT: 'new-message-recieved',
  MESSAGE_DELIVERED_EVENT: 'message-delivered',
  MESSAGE_SEEN_EVENT: 'message-seen',
  MARK_MESSAGES_SEEN_EVENT: 'mark-message-seen',
  UPDATE_CHAT_LAST_MESSAGE_EVENT: 'updateChatLastMessage',
  NEW_CHAT_EVENT: 'new-chat',
  TYPING_EVENT: 'typing',
  STOP_TYPING_EVENT: 'stopTyping',
  SOCKET_ERROR_EVENT: 'socketError',
  LEAVE_CHAT_EVENT: 'leaveChat',
  NEW_GROUP_NAME: 'newGroupName',
  REACTION_RECEIVED_EVENT: 'reaction-received',
  CHAT_MESSAGE_DELETE_EVENT: 'chat-message-delete',

  USER_ONLINE_EVENT: 'userOnline',
  USER_OFFLINE_EVENT: 'userOffline',
  USER_WENT_ONLINE_EVENT: 'userWentOnline',
  USER_WENT_OFFLINE_EVENT: 'userWentOffline',
  CHECK_ONLINE_STATUS_EVENT: 'checkOnlineStatus',
  ONLINE_STATUS_RESPONSE_EVENT: 'onlineStatusResponse',
};

export const AvailableSocketEvents = Object.values(SocketEventEnum);
