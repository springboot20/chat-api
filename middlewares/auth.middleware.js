import { StatusCodes } from 'http-status-codes';
import { validateToken } from '../utils/jwt.js';
import { userModel } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const verifyJWT = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.accessToken ?? req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'verifyJWT Invalid');
  }

  try {
    let decodedToken = validateToken(token, process.env.ACCESS_TOKEN_SECRET);

    const user = await userModel
      .findById(decodedToken?._id)
      .select('-password -refreshToken -emailVerificationToken -emailVerificationExpiry');

    if (!user) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid Token provided');
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'verifyJWT Invalid');
  }
});

const checkUserPermissions = (...roles) =>
  asyncHandler(async (req, res, next) => {
    if (!req.user._id) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'Unauthorized request');
    }

    if (roles.includes(req.user.role)) {
      next();
    } else {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not allow to perform such action');
    }
  });

export { verifyJWT, checkUserPermissions };
