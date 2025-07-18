export const UserRoles = {
  USER: "USER",
  ADMIN: "ADMIN",
};

export const AvailableUserRole = Object.values(UserRoles);

export const LoginType = {
  EMAIL_PASSWORD: "EMAIL_PASSWORD",
  GOOGLE: "GOOGLE",
};

export const AvailableLoginType = Object.values(LoginType);

export const SocketEventEnum = {
  JOIN_CHAT_EVENT: "joinChat",
  CONNECTED_EVENT: "connected",
  DISCONNECT_EVENT: "disconnect",
  NEW_MESSAGE_RECEIVED_EVENT: "new-message-recieved",
  NEW_CHAT_EVENT: "new-chat",
  TYPING_EVENT: "typing",
  STOP_TYPING_EVENT: "stopTyping",
  SOCKET_ERROR_EVENT: "socketError",
  LEAVE_CHAT_EVENT: "leaveChat",
  NEW_GROUP_NAME: "newGroupName",
  REACTION_RECEIVED_EVENT: "reaction-received",
  CHAT_MESSAGE_DELETE_EVENT: "chat-message-delete",
};

export const AvailableSocketEvents = Object.values(SocketEventEnum);
