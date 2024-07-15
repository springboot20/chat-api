import crypto from 'crypto';
import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { userModel } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { UserRoles } from '../../constants/constants.js';
import { generateTokens } from '../../helpers/index.js';
import { withTransaction } from '../../middlewares/mongoose.middleware.js';
import { getLocalFilePath, getStaticFilePath } from '../../helpers/index.js';
// import { sendMail } from '../../service/email.service.js';
import { validateToken } from '../../utils/jwt.js';

const registerUser = asyncHandler(async (req, res) => {
  const { username, email, password, role } = req.body;

  const existingUser = await userModel.findOne({ $or: [{ email }, { username }] });

  if (existingUser) {
    throw new ApiError(StatusCodes.CONFLICT, 'user with username or email already exists', []);
  }

  const user = await userModel.create({
    username,
    email,
    password,
    role: role || UserRoles.USER,
    isEmailVerified: false,
  });

  const { unHashedToken, hashedToken, tokenExpiry } = user.generateTemporaryToken();

  user.emailVerificationToken = hashedToken;
  user.emailVerificationExpiry = tokenExpiry;

  await user.save({ validateBeforeSave: false });

  const verificationLink = `${req.protocol}://${req.get('host')}/api/v1/verify-email/${
    user?._id
  }/${unHashedToken}`;
  // await sendMail(user.email, 'Email verification', { verificationUrl: verificationLink, username: user.username }, 'email-verification');

  const createdUser = await userModel
    .findById(user._id)
    .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

  if (!createdUser) {
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      'Something went wrong while creating the user',
      []
    );
  }

  res.render('email-verification')

  return new ApiResponse(StatusCodes.OK, 'user successfully created', {
    user: createdUser,
  });
});

const loginUser = asyncHandler(async (req, res) => {
  const { username, email, password } = req.body;

  const user = await userModel.findOne({ $or: [{ email }, { username }] });

  if (!user)
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      `No user found with this email: ${email} or username: ${username}`
    );

  if (email && !password)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'please provide an email and a password');

  console.log(password, user.password);
  if (!(await user.isPasswordsCorrect(password))) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'invalid password entered');
  }

  const { accessToken, refreshToken } = await generateTokens(user._id);

  const loggedInUser = await userModel
    .findById(user._id)
    .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

  return new ApiResponse(StatusCodes.OK, 'user logged in successfully', {
    user: loggedInUser,
    tokens: { accessToken, refreshToken },
  });
});

const verifyEmail = asyncHandler(
  withTransaction(async (req, res, session) => {
    const { verifyLink: token } = req.params;

    if (!token) throw new ApiError(StatusCodes.BAD_REQUEST, 'Verification token is missing', []);
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const verifiedUser = await userModel.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpiry: { $gte: Date.now() },
    });

    verifiedUser.emailVerificationToken = undefined;
    verifiedUser.emailVerificationExpiry = undefined;

    verifiedUser.isEmailVerified = true;

    await verifiedUser.save({ validateBeforeSaving: false, session });

    return new ApiResponse(StatusCodes.OK, 'Email verified', { isEmailVerified: true });
  })
);

const resendEmailVerification = asyncHandler(
  withTransaction(async (req, res, session) => {
    const user = await userModel.findById(req.user._id);

    if (!user) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'User does not exists', []);
    }

    if (user.isEmailVerified) {
      throw new ApiError(StatusCodes.CONFLICT, 'User email has already been verified', []);
    }

    const { unHashedToken, hashedToken, tokenExpiry } = generateTemporaryToken();

    user.emailVerificationExpiry = new Date(tokenExpiry);
    user.emailVerificationToken = hashedToken;

    await user.save({ validateBeforeSave: false, session });

    const verifyLink = `${req.protocol}://${req.get('host')}/api/v1/verify-email/${unHashedToken}`;

    // await sendMail(user?.email, 'Email verification', { username: user?.username, verificationLink: verifyLink }, 'email-verification');
    return new ApiResponse(StatusCodes.OK, 'User registration successful', {});
  })
);

const logOut = asyncHandler(
  withTransaction(
    /**
     * 
     * @param {import("express").Request} req 
     * @param {import("express").Response} res 
     * @param {mongoose.Session} session 
     * @returns 
     */
    async (req, res, session) => {
    await userModel.findOneAndUpdate(
      { _id: req.user._id },
      {
        $set: {
          refreshToken: undefined,
        },
      },
      { new: true }
    );

    return new ApiResponse(StatusCodes.OK, 'you have successfully logged out');
  })
);

const forgotPassword = asyncHandler(
  withTransaction(async (req, res, session) => {
    const { email } = req.body;

    const user = await userModel.findOne({ email });
    if (!user) throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');

    const { unHashedToken, hashedToken, token } = user.generateTemporaryToken();

    user.forgotPasswordToken = hashedToken;
    user.forgotPasswordExpiry = token;

    const resetLink = `${req.protocol}//:${req.get('host')}/api/v1/reset-password/${unHashedToken}`;
    // await sendMail(user.email, 'Password reset', { resetLink, username: user.username }, 'reset-password');

    await user.save({ validateBeforeSave: false, session });
    return new ApiResponse(StatusCodes.OK, 'Password reset link sent to your email');
  })
);

const resetPassword = asyncHandler(
  withTransaction(async (req, res, session) => {
    const {
      params: { resetToken: token },
    } = req;
    const { password } = req.body;

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await userModel.findOne({
      _id: req.user._id,
      resetToken: hashedToken,
      resetTokenExpiry: { $gte: Date.now() },
    });
    if (!user) throw new ApiError(StatusCodes.NOT_FOUND, 'Token is invalid or expired', []);

    const updatedUser = await userModel.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          password: password,
          forgotPasswordToken: undefined,
          forgotPasswordExpiry: undefined,
        },
      },
      { new: true }
    );

    await updatedUser.save({ validateBeforeSave: false, session });
    return new ApiResponse(StatusCodes.OK, 'Password reset successfully', {});
  })
);

const uploadAvatar = asyncHandler(
  withTransaction(async (req, res, session) => {
    if (!req.file?.filename) throw new ApiError(StatusCodes.BAD_REQUEST, 'No file uploaded', []);

    const avatarLocalPath = getLocalFilePath(req.file.filename);
    const avatarStaticPath = getStaticFilePath(req, req.file.filename);

    const userAvatarUpdate = await userModel
      .findOneAndUpdate(
        { _id: req.user._id },
        {
          $set: {
            avatar: {
              url: avatarStaticPath,
              localPath: avatarLocalPath,
            },
          },
        },
        { new: true }
      )
      .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

    await userAvatar.save({ validateBeforeSave: false, session });

    return new ApiResponse(StatusCodes.OK, 'avatar updated successfully', { userAvatarUpdate });
  })
);

const refreshAccessToken = asyncHandler(
  withTransaction(async (req, res, session) => {
    const {
      body: { inComingRefreshToken },
    } = req;

    try {
      const decodedRefreshToken = validateToken(
        inComingRefreshToken,
        process.env.JWT_REFRESH_SECRET
      );
      let user = await userModel.findByIdAndUpdate(decodedRefreshToken?._id);

      if (!user) {
        throw new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid Token');
      }

      if (inComingRefreshToken !== user?.refreshToken) {
        throw new ApiError(StatusCodes.UNAUTHORIZED, 'Token has expired or has already been used');
      }

      const { accessToken, refreshToken } = await generateTokens(res, user?._id.toString());
      user.refreshToken = refreshToken;
      await user.save({ session });

      return new ApiResponse(
        StatusCodes.OK,
        { tokens: { accessToken, refreshToken } },
        'AccessToken refreshed successfully'
      );
    } catch (error) {
      return new ApiError(StatusCodes.UNAUTHORIZED, `Error : ${error}`);
    }
  })
);

const getCurrentUser = asyncHandler(async (req, res) => {
  return new ApiResponse(StatusCodes.OK, 'AccessToken refreshed successfully', { user: req.user });
});

const changeCurrentPassword = asyncHandler(
  withTransaction(async (req, res, session) => {
    let {
      body: { existingPassword, newPassword },
    } = req;

    const user = await userModel.findById(req.user._id);

    if (!user) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'User not found', []);
    }

    let isPasswordValid = isPasswordCorrect(existingPassword, user.password);

    if (!isPasswordValid) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Existing password does not matched');
    }

    user.password = newPassword;
    await user.save({ validateBeforeSave: false, session });

    return new ApiResponse(StatusCodes.OK, 'Current password changed', {});
  })
);

export {
  registerUser,
  loginUser,
  verifyEmail,
  uploadAvatar,
  logOut,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  changeCurrentPassword,
  getCurrentUser,
  resendEmailVerification,
};
