import { Router } from "express";
import { messageController } from "../../controllers/index.js";
import { verifyJWT } from "../../middlewares/auth.middleware.js";
import { upload } from "../../middlewares/multer.middleware.js";
import { mongoPathVariableValidation } from "../../validation/mongo/mongoId.validators.js";
import { validate } from "../../validation/validate.middleware.js";

export const router = Router();

router.use(verifyJWT);

router
  .route("/:chatId")
  .get(
    mongoPathVariableValidation("chatId"),
    validate,
    messageController.getAllChats
  )
  .post(
    upload.fields([{ name: "attachments", maxCount: 6 }]),
    messageController.createMessage
  );
