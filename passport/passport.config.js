import { Strategy as LocalStrategy } from 'passport-local';
import passport from 'passport';
import { userModel } from '../models/index.js';
import { LoginType } from '../constants/constants';
import { ApiError } from '../utils/ApiError.js';
import { StatusCodes } from 'http-status-codes';

passport.use(
  new LocalStrategy(async (username, email, password, next) => {
    const user = await userModel
      .findOne({ $or: [{ email }, { username }] })
      .then(async (user) => {
        if (user?.loginType !== LoginType.EMAIL_PASSWORD) {
          next(
            new ApiError(
              400,
              `You have previously registered using ${user?.loginType
                .toLowerCase()
                .split('_')
                .join(' ')}. Please use the ${user?.loginType
                .toLowerCase()
                .split('_')
                .join(' ')} login option to access your account`
            ),
            null
          );
        }
        const isValidPassword = await user?.isPasswordCorrect(password);
        if (!isValidPassword) {
          next(new ApiError(409, 'Invalid password, please check your password'), null);
        }

        return next(null, user);
      })
      .catch((error) => {
        next(new ApiError(409, 'Something went wrong while registering user'), null);
      });
  })
);

passport.serializeUser((user, next) => {
  next(null, user?._id);
});

passport.deserializeUser(async (id, next) => {
  await userModel
    .findById(id)
    .then((user) => {
      if (user) next(null, user);
      else next(new ApiError(StatusCodes.NOT_FOUND, 'User does not exist'), null);
    })
    .catch((error) => {
      next(
        new ApiError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          `Something went wrong while trying to serialize user. Error : ${error}`
        ),
        null
      );
    });
});
