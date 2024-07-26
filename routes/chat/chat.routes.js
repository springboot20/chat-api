import { Router } from "express";
import { chatController } from "../../controllers/index.js";
import { validate } from "../../validation/validate.middleware.js";
import { verifyJWT } from "../../middlewares/auth.middleware.js";
import { mongoPathVariableValidation } from "../../validation/mongo/mongoId.validators.js";
import { getAllChats } from "../../controllers/chat/message.controller.js";

export const router = Router();

router.use(verifyJWT);

router.route("/").get(getAllChats);

router
  .route("/create-chat/:receiverId")
  .post(
    validate,
    mongoPathVariableValidation("receiverId"),
    chatController.GetOrCreateChatMessage
  );

router.route("/group-chat").post(chatController.createGroupChat);

router
  .route("/group-chat/:chatId")
  .get(
    mongoPathVariableValidation("chatId"),
    validate,
    chatController.getGroupChatDetails
  )
  .patch(
    mongoPathVariableValidation("chatId"),
    validate,
    chatController.changeGroupName
  )
  .delete(
    mongoPathVariableValidation("chatId"),
    validate,
    chatController.deleteGroupChat
  );

router
  .route("/group-chat/:chatId/:participantId")
  .post(
    mongoPathVariableValidation("chatId"),
    mongoPathVariableValidation("participantId"),
    validate,
    chatController.addParticipantToGroupChat
  )
  .delete(
    mongoPathVariableValidation("chatId"),
    mongoPathVariableValidation("participantId"),
    validate,
    chatController.removeParticipantFromGroupChat
  );

router
  .route("/leave/group-chat/:chatId")
  .delete(
    mongoPathVariableValidation("chatId"),
    validate,
    chatController.leaveGroupChat
  );

router
  .route("/delete-one-on-one/:chatId")
  .delete(
    validate,
    mongoPathVariableValidation("chatId"),
    chatController.deleteOneOnOneChat
  );
