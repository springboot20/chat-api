import { Schema, model } from 'mongoose';
import {
  AvailableUserRole,
  UserRoles,
  LoginType,
  AvailableLoginType,
} from '../../constants/constants.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jsonwebtoken from 'jsonwebtoken';

const userSchema = new Schema(
  {
    username: {
      type: String,
      index: true,
      trim: true,
      required: true,
      lowercase: true,
      unique: true,
    },
    avatar: {
      type: {
        url: String,
        localPath: String,
      },
    },
    email: {
      type: String,
      unique: true,
      lowercase: true,
      required: true,
    },
    password: {
      type: String,
      required: true,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: AvailableUserRole,
      default: UserRoles.USER,
    },
    refreshToken: {
      type: String,
    },
    loginType: {
      type: String,
      enum: AvailableLoginType,
      default: LoginType.EMAIL_PASSWORD,
    },
    emailVerificationToken: {
      type: String,
    },
    emailVerificationExpiry: {
      type: Date,
    },
    forgotPasswordToken: {
      type: String,
    },
    forgotPasswordExpiry: {
      type: Date,
    },
  },
  { timestamps: true },
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10); // 10 is a reasonable salt rounds value

    this.password = await bcrypt.hash(this.password, salt);

    next();
  } catch (error) {
    next(error); // Pass error to next middleware
  }
});

userSchema.methods.isPasswordsCorrect = async function (entered_password) {
  console.log(await bcrypt.compare(entered_password, this.password));
  return await bcrypt.compare(entered_password, this.password);
};

userSchema.methods.generateAccessToken = function () {
  const payload = {
    _id: this._id,
    username: this.username,
    email: this.email,
    role: this.role,
  };

  return jsonwebtoken.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES,
  });
};

userSchema.methods.generateRefreshToken = function () {
  const payload = { _id: this._id };
  return jsonwebtoken.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRES,
  });
};

userSchema.methods.generateTemporaryToken = function () {
  const unHashedToken = crypto.randomBytes(20).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(unHashedToken).digest('hex');

  const tokenExpiry = 5 * 60 * 1000;

  return { unHashedToken, hashedToken, tokenExpiry };
};

userSchema.index({ username: 1 });
userSchema.index({ email: 1 });

const userModel = model('User', userSchema);
export { userModel };
