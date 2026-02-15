import { Router } from 'express';
import * as controllers from '../../controllers/index.js';
import { verifyJWT } from '../../middlewares/auth.middleware.js';
import {
  userRegisterValidation,
  userLoginValidation,
  userChangeCurrentPasswordValidation,
  userForgotPasswordValidation,
  userResetPasswordValidation,
} from '../../validation/app/user.validators.js';
import { validate } from '../../validation/validate.middleware.js';
import { upload } from '../../middlewares/multer.middleware.js';

export const router = Router();
/**
 * UNPROTECTED ROUTES
 */

router
  .route('/register')
  .post(userRegisterValidation(), validate, controllers.authController.registerUser);

router.route('/login').post(userLoginValidation(), validate, controllers.authController.loginUser);

router.route('/refresh').post(controllers.authController.refreshAccessToken);

router.route('/verify-email/:verificationToken').post(controllers.authController.verifyEmail);

router
  .route('/forgot-password')
  .post(userForgotPasswordValidation(), validate, controllers.authController.forgotPassword);

router
  .route('/reset-password/:resetToken')
  .patch(userResetPasswordValidation(), validate, controllers.authController.resetPassword);

/**
 * PROTECTED ROUTES
 */
router.route('/logout').post(verifyJWT, controllers.authController.logOut);

router.route('/available-users').get(verifyJWT, controllers.authController.getUsers);

router
  .route('/resend-email-verification')
  .post(verifyJWT, controllers.authController.resendEmailVerification);

router
  .route('/change-current-password')
  .get(
    verifyJWT,
    userChangeCurrentPasswordValidation(),
    validate,
    controllers.authController.changeCurrentPassword,
  );

router.route('/current-user').get(verifyJWT, controllers.authController.getCurrentUser);

router
  .route('/upload-avatar')
  .post(verifyJWT, upload.single('avatar'), controllers.authController.uploadAvatar);
