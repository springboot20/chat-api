import fs from "fs";
import { userModel } from "./models/index.js";
import { ApiError } from "./utils/ApiError.js";
import { StatusCodes } from "http-status-codes";
import path from "path";
import url from "url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 *
 * @param {string} userId
 * @returns {accessToken: string, refreshToken: string}
 *
 * A function which generate tokens i.e {accessToken and refreshToken} from the pre-defined function in the mongoose model
 */

export const generateTokens = async (userId) => {
  try {
    // find user with the id generated for a user when they create an account
    const user = await userModel.findById(userId);

    // check if the user is not found in the database
    if (!user) throw new ApiError(StatusCodes.NOT_FOUND, "user does not exist in the database");

    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;

    user.save({ validateBeforeSave: false });
    return { accessToken, refreshToken };
  } catch (error) {
    throw error;
  }
};

export const getStaticFilePath = (req, filename) =>
  `${req.protocol}://${req.get("host")}/images/${filename}`;
export const getLocalFilePath = (filename) => `${__dirname}/public/images/${filename}`;

export const removeUnusedMulterFilesOnError = (req) => {
  try {
    let multerFiles = req.files;
    let multerFile = req.file;

    if (multerFile) {
      fs.unlinkSync(getLocalFilePath(multerFile.filename));
    }
  } catch (error) {
    console.log(` Error while removing image files : ${error}`);
  }
};

export const removeLocalFile = (localPath) => {
  fs.unlink(localPath, (err) => {
    if (err) console.log("Error occur while trying to remove file");
    else console.log(`Removed file:${localPath}`);
  });
};

export const asyncFunc = (fn) => {
  return async (arg) => {
    await new Promise.resolve(fn(arg)).catch((err) => {
      throw err;
    });
  };
};
