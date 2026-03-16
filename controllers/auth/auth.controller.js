import bcrypt from 'bcrypt';
import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ContactModel, userModel } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { UserRoles } from '../../constants/constants.js';
import {
  generateTokens,
  getLocalFilePath,
  getStaticFilePath,
  removeLocalFile,
  removeUnusedMulterFilesOnError,
} from '../../helper.js';
import { validateToken } from '../../utils/jwt.js';
import mongoose from 'mongoose';
import {
  deleteFileFromCloudinary,
  uploadFileToCloudinary,
} from '../../configs/cloudinary.config.js';
import { sendMail } from '../../service/email.service.js';

const mode = process.env.NODE_ENV;

const registerUser = asyncHandler(async (req, res) => {
  const { username, email, password, role } = req.body;

  let avatarImage = undefined;

  if (req.file) {
    const isProduction = mode === 'production';

    let finalUrl = '';
    let publicId = null;

    try {
      if (isProduction) {
        const cloudinaryResponse = await uploadFileToCloudinary(
          req.file.path,
          `${process.env.CLOUDINARY_BASE_FOLDER}/images`,
        );

        finalUrl = cloudinaryResponse.secure_url;
        publicId = cloudinaryResponse.public_id;

        removeLocalFile(req.file.path);
      } else {
        finalUrl = getStaticFilePath(req, 'images', req.file.filename);
      }

      avatarImage = {
        url: finalUrl,
        localPath: isProduction ? null : getLocalFilePath('images', req.file.filename),
        public_id: publicId ? publicId : undefined,
      };
    } catch (error) {
      // SAFETY: Cleanup all files if any single upload fails to prevent junk on disk
      removeUnusedMulterFilesOnError(req);
      throw new ApiError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        'File processing failed: ' + error.message,
      );
    }
  }

  const existingUser = await userModel.findOne({
    $or: [{ email }, { username }],
  });

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

  user.avatar = avatarImage;

  await user.save({ validateBeforeSave: false });
  const name = `${user.firstname} ${user.lastname}`;

  const link =
    process.env.NODE_ENV === 'production' ? process.env.BASE_URL_PROD : process.env.BASE_URL_DEV;

  const verificationUrl = `${link}/auth/verify-email/?userId=${user?._id}&token=${unHashedToken}`;

  await sendMail({
    to: user.email,
    subject: 'Email verification',
    data: {
      verificationUrl,
      name,
      appName: process.env.APP_NAME,
    },
    templateName: 'verify-mail',
  });

  const createdUser = await userModel
    .findById(user._id)
    .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

  if (!createdUser) {
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      'Something went wrong while creating the user',
      [],
    );
  }

  return new ApiResponse(StatusCodes.OK, 'user successfully created', {
    user: createdUser,
    url: verificationUrl,
  });
});

const loginUser = asyncHandler(async (req, res) => {
  const { username, email, password } = req.body;

  const user = await userModel.findOne({ $or: [{ email }, { username }] });

  if (!user)
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      `No user found with this email: ${email} or username: ${username}`,
    );

  if (!email && !password)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'please provide an email and a password');

  if (!(await user.isPasswordCorrect(password))) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'invalid password entered');
  }

  const { accessToken, refreshToken } = await generateTokens(user._id);

  return new ApiResponse(StatusCodes.OK, 'user logged in successfully', {
    tokens: { accessToken, refreshToken },
  });
});

const verifyEmail = asyncHandler(async (req, res) => {
  const { token, userId } = req.query;

  if (!token || !userId) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Verification token or userId is missing', []);
  }

  const user = await userModel.findById(userId);

  if (!user) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Token is invalid or expired');
  }

  // ✅ Handle already-verified case gracefully
  if (user.isEmailVerified) {
    return res.status(StatusCodes.OK).json(
      new ApiResponse(StatusCodes.OK, 'Email is already verified', {
        isEmailVerified: true,
        status: 'success',
      }),
    );
  }

  // ✅ Guard against missing token on the user doc
  if (!user.emailVerificationToken || !user.emailVerificationExpiry) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Token is invalid or expired');
  }

  if (user.emailVerificationExpiry < Date.now()) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Verification token has expired');
  }

  const hashedToken = await bcrypt.compare(token, user.emailVerificationToken);

  if (!hashedToken) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid email verification token provided');
  }

  user.emailVerificationToken = undefined;
  user.emailVerificationExpiry = undefined;
  user.isEmailVerified = true;

  await user.save({ validateBeforeSave: false });

  return new ApiResponse(StatusCodes.OK, 'Email verified successfully', {
    isEmailVerified: true,
    status: 'success',
  });
});

const resendEmailVerification = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user._id);

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User does not exists', []);
  }

  if (user.isEmailVerified) {
    throw new ApiError(StatusCodes.CONFLICT, 'User email has already been verified', []);
  }

  const { unHashedToken, hashedToken, tokenExpiry } = user.generateTemporaryToken();

  user.emailVerificationExpiry = new Date(tokenExpiry);
  user.emailVerificationToken = hashedToken;

  await user.save({ validateBeforeSave: false });

  const link =
    process.env.NODE_ENV === 'production' ? process.env.BASE_URL_PROD : process.env.BASE_URL_DEV;

  const verificationUrl = `${link}/auth/verify-email/?userId=${user?._id}&token=${unHashedToken}`;

  const name = `${user.firstname} ${user.lastname}`;

  await sendMail({
    to: user.email,
    subject: 'Email verification',
    templateName: 'resend-verification',
    data: {
      verificationUrl,
      name,
      from: process.env.EMAIL,
      app: process.env.APP_NAME,
    },
  });

  return new ApiResponse(StatusCodes.OK, 'User registration successful', { url: verificationUrl });
});

const logOut = asyncHandler(
  /**
   *
   * @param {import("express").Request} req
   * @param {import("express").Response} res
   * @returns
   */
  async (req, res) => {
    await userModel.findOneAndUpdate(
      { _id: req.user._id },
      {
        $set: {
          refreshToken: undefined,
        },
      },
      { new: true },
    );

    return new ApiResponse(StatusCodes.OK, 'you have successfully logged out');
  },
);

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  const user = await userModel.findOne({ email });
  if (!user) throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');

  const { unHashedToken, hashedToken, token } = user.generateTemporaryToken();

  user.forgotPasswordToken = hashedToken;
  user.forgotPasswordExpiry = token;
  await user.save({ validateBeforeSave: false });

  const name = `${user.firstname} ${user.lastname}`;

  const link =
    process.env.NODE_ENV === 'production' ? process.env.BASE_URL_PROD : process.env.BASE_URL_DEV;

  const resetUrl = `${link}/auth/reset-password/${unHashedToken}`;

  await sendMail({
    to: user.email,
    subject: 'Password reset',
    data: {
      resetUrl,
      name,
      appName: process.env.APP_NAME,
    },
    templateName: 'forgot-password',
  });

  return new ApiResponse(StatusCodes.OK, 'Password reset link sent to your email', {
    success: true,
    url: resetUrl,
  });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.query;
  const { password } = req.body;

  const user = await userModel.findOne({
    _id: req.user._id,
  });

  if (!user) throw new ApiError(StatusCodes.NOT_FOUND, 'Token is invalid or expired', []);

  const validToken = await bcrypt.compare(token, user.forgotPasswordToken);

  if (!validToken) {
    throw new CustomErrors('Invalid reset password token provided', StatusCodes.UNAUTHORIZED);
  }

  user.forgotPasswordToken = undefined;
  user.forgotPasswordTokenExpiry = undefined;
  user.password = password;

  await user.save({ validateBeforeSave: false });

  return new ApiResponse(StatusCodes.OK, 'Password reset successfully', {});
});

const uploadAvatar = asyncHandler(async (req, res) => {
  // Check if file exists (using path/filename depending on your Multer setup)
  console.log(req.file);
  if (!req.file) throw new ApiError(StatusCodes.BAD_REQUEST, 'No file uploaded');

  const user_id = req?.user?._id;

  const user = await userModel.findById(user_id);

  let avatarImage = undefined;

  if (req.file) {
    const isProduction = mode === 'production';

    let finalUrl = '';
    let publicId = null;

    try {
      if (isProduction) {
        if (user?.avatar?.public_id) {
          await deleteFileFromCloudinary(user?.avatar?.public_id);
        }

        const cloudinaryResponse = await uploadFileToCloudinary(
          req.file.path,
          `${process.env.CLOUDINARY_BASE_FOLDER}/images`,
        );

        finalUrl = cloudinaryResponse.secure_url;
        publicId = cloudinaryResponse.public_id;

        removeLocalFile(req.file.path);
      } else {
        finalUrl = getStaticFilePath(req, 'images', req.file.filename);
      }

      avatarImage = {
        url: finalUrl,
        localPath: isProduction ? null : getLocalFilePath('images', req.file.filename),
        public_id: publicId ? publicId : null,
      };
    } catch (error) {
      // SAFETY: Cleanup all files if any single upload fails to prevent junk on disk
      removeUnusedMulterFilesOnError(req);
      throw new ApiError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        'File processing failed: ' + error.message,
      );
    }
  }

  const updatedUser = await userModel
    .findOneAndUpdate({ _id: req.user._id }, { $set: { avatar: avatarImage } }, { new: true })
    .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

  return new ApiResponse(StatusCodes.OK, 'Avatar updated successfully', updatedUser);
});

const refreshAccessToken = asyncHandler(async (req, res) => {
  const {
    body: { inComingRefreshToken },
  } = req;

  console.log(inComingRefreshToken);

  const decodedRefreshToken = validateToken(inComingRefreshToken, process.env.JWT_REFRESH_SECRET);
  let user = await userModel.findByIdAndUpdate(decodedRefreshToken?._id);

  if (!user) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid Token');
  }

  if (inComingRefreshToken !== user?.refreshToken) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Token has expired or has already been used');
  }

  const { accessToken, refreshToken } = await generateTokens(res, user?._id.toString());
  user.refreshToken = refreshToken;
  await user.save({});

  return new ApiResponse(
    StatusCodes.OK,
    { tokens: { accessToken, refreshToken } },
    'AccessToken refreshed successfully',
  );
});

const getCurrentUser = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const user = await userModel
    .findById(userId)
    .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

  return new ApiResponse(StatusCodes.OK, 'user fetched successfully', {
    user,
  });
});

const changeCurrentPassword = asyncHandler(async (req, res) => {
  let {
    body: { existingPassword, newPassword },
  } = req;

  const user = await userModel.findById(req.user._id);

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found', []);
  }

  let isPasswordValid = user.isPasswordCorrect(existingPassword, user.password);

  if (!isPasswordValid) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Existing password does not matched');
  }

  user.password = newPassword;
  await user.save({ validateBeforeSave: false });

  return new ApiResponse(StatusCodes.OK, 'Current password changed', {});
});

const getUsers = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const search = req.query.search || '';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, parseInt(req.query.limit) || 10);
  const skip = (page - 1) * limit;

  const myContacts = await ContactModel.find({ owner: userId }).select('contact');
  const contactIds = myContacts.map((c) => c.contact);

  // 1. Build the match condition dynamically
  const matchCondition = {
    _id: {
      $ne: new mongoose.Types.ObjectId(userId), // Exclude me
      $nin: contactIds, // Exclude my contacts
    },
  };

  // 2. ONLY add search if it exists. If not, it just returns everyone else.
  if (search.trim()) {
    matchCondition.$or = [
      { username: { $regex: search.trim(), $options: 'i' } },
      { email: { $regex: search.trim(), $options: 'i' } },
    ];
  }

  const usersAggregation = await userModel.aggregate([
    { $match: matchCondition }, // Apply the dynamic condition
    {
      $facet: {
        metadata: [{ $count: 'total' }],
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: { password: 0, refreshToken: 0 },
          },
        ],
      },
    },
  ]);

  const users = usersAggregation[0]?.data || [];
  const totalUsers = usersAggregation[0]?.metadata[0]?.total || 0;
  const totalPages = Math.ceil(totalUsers / limit);
  const hasMore = page < totalPages;

  return new ApiResponse(StatusCodes.OK, 'Available users fetched', {
    users,
    pagination: { hasMore, limit, page, total: totalUsers, totalPages },
  });
});

const updateAccount = asyncHandler(async (req, res) => {
  const { username, about } = req.body;

  const updatedUser = await userModel
    .findByIdAndUpdate(req.user._id, { $set: { username, about } }, { new: true })
    .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

  return new ApiResponse(StatusCodes.OK, 'Account updated successfully', updatedUser);
});

const resendEmailVerificationForNewUser = asyncHandler(
  /**
   * @param {import("express").Request} req
   * @param {import("express").Response} res
   */

  async (req, res) => {
    const { email } = req.body;

    const user = await userModel.findOne({ email });

    if (!user) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'user does not exists', []);
    }

    const { unHashedToken, hashedToken, tokenExpiry } = user.generateTemporaryToken();

    user.emailVerificationToken = hashedToken;
    user.emailVerificationTokenExpiry = tokenExpiry;
    user.isEmailVerified = false;

    await user.save({ validateBeforeSave: false });

    const link =
      process.env.NODE_ENV === 'production' ? process.env.BASE_URL_PROD : process.env.BASE_URL_DEV;

    const verificationUrl = `${link}/auth/verify-email/?userId=${user?._id}&token=${unHashedToken}`;

    const name = `${user.firstname} ${user.lastname}`;

    await sendMail({
      to: user.email,
      subject: 'Email verification',
      templateName: 'resend-verification',
      data: {
        verificationUrl,
        name,
        from: process.env.EMAIL,
        app: process.env.APP_NAME,
      },
    });

    return new ApiResponse(StatusCodes.OK, 'Email verification resent', { url: verificationUrl });
  },
);

export {
  registerUser,
  loginUser,
  verifyEmail,
  uploadAvatar,
  logOut,
  forgotPassword,
  updateAccount,
  resetPassword,
  refreshAccessToken,
  changeCurrentPassword,
  getCurrentUser,
  resendEmailVerification,
  getUsers,
  resendEmailVerificationForNewUser,
};