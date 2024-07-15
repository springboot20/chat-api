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
  .post(validate, userRegisterValidation(), controllers.authController.registerUser);

router.route('/login').post(validate, userLoginValidation(), controllers.authController.loginUser);

router.route('/verify-email/:verificationToken').post(controllers.authController.verifyEmail);

router
  .route('/forgot-password')
  .post(validate, userForgotPasswordValidation(), controllers.authController.forgotPassword);

router
  .route('/reset-password/:resetToken')
  .patch(validate, userResetPasswordValidation(), controllers.authController.resetPassword);

/**
 * PROTECTED ROUTES
 */
router.route('/logout').post(verifyJWT, controllers.authController.logOut);

router
  .route('/resend-email-verification')
  .post(verifyJWT, controllers.authController.resendEmailVerification);

router
  .route('/change-current-password')
  .get(
    validate,
    userChangeCurrentPasswordValidation(),
    verifyJWT,
    controllers.authController.changeCurrentPassword
  );

router.route('/current-user').get(verifyJWT, controllers.authController.getCurrentUser);

router
  .route('/upload-avatar')
  .post(verifyJWT, upload.single('avatar'), controllers.authController.uploadAvatar);
