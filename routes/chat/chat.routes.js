import { Router } from 'express';
import { chatController } from '../../controllers/index.js';
import { validate } from '../../validation/validate.middleware.js';
import { verifyJWT } from '../../middlewares/auth.middleware.js';
import { mongoPathVariableValidation } from '../../validation/mongo/mongoId.validators.js';

export const router = Router();

router.use(verifyJWT);

router
  .route('/create-chat/:receiverId')
  .post(validate, mongoPathVariableValidation('receiverId'), chatController.GetOrCreateChatMessage);

router.route('/group-chat').post(chatController.createGroupChat);
router
  .route('/group-chat/:chatId')
  .get(validate, mongoPathVariableValidation('chatId'), chatController.getGroupChatDetails);

router.route('/delete-one-on-one/:chatId').delete(validate, mongoPathVariableValidation('chatId'));
router.route('/delete-group/:chatId').delete(validate, mongoPathVariableValidation('chatId'));
router.route('//:chatId').post(validate, mongoPathVariableValidation('chatId'));
