import { Router } from "express";
import { getLinkPreview } from "../../controllers/chat/message.controller.js";
import { verifyJWT } from "../../middlewares/auth.middleware.js";

export const router = Router();

router.use(verifyJWT);

router.route("/link-preview").get(getLinkPreview);

