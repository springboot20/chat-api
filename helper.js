import fs from 'fs';
import { userModel } from './models/index.js';
import { ApiError } from './utils/ApiError.js';
import { StatusCodes } from 'http-status-codes';
import path from 'path';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const generateTokens = async (userId) => {
  try {
    const user = await userModel.findById(userId);
    if (!user) throw new ApiError(StatusCodes.NOT_FOUND, 'user does not exist');

    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false }); // Added await
    return { accessToken, refreshToken };
  } catch (error) {
    throw error;
  }
};

/**
 * Ensures the local directory exists and returns the resolved path
 */
export const uploadLocalFiles = (uploadDirectory) => {
  const absolutePath = path.resolve(process.cwd(), uploadDirectory);

  if (!fs.existsSync(absolutePath)) {
    fs.mkdirSync(absolutePath, { recursive: true });
  }

  return absolutePath;
};

/**
 * Returns the URL for the frontend to access the file
 */
export const getStaticFilePath = (req, folder, fileName) => {
  // Assuming 'public' is served as static, so it's not part of the URL
  return `${req.protocol}://${req.get('host')}/uploads/${folder}/${fileName}`;
};

/**
 * Returns the relative path for database storage and unlinking
 */
export const getLocalFilePath = (folder, fileName) => {
  return path.join('public', 'uploads', folder, fileName);
};

/**
 * Cleanup function for failed requests (e.g., if DB save fails after upload)
 */
export const removeUnusedMulterFilesOnError = (req) => {
  try {
    const files = req.files; // For .fields() or .array()
    const file = req.file; // For .single()

    if (file) {
      removeLocalFile(file.path);
    }

    if (files) {
      // req.files is an object when using .fields()
      const fileValues = Object.values(files).flat();
      fileValues.forEach((f) => removeLocalFile(f.path));
    }
  } catch (error) {
    console.error(`Error while removing image files: ${error}`);
  }
};

export const removeLocalFile = (localPath) => {
  if (!localPath) return;

  if (fs.existsSync(localPath)) {
    fs.unlink(localPath, (err) => {
      if (err) console.error('Error occurred while removing file:', err);
      else console.log(`Removed local file: ${localPath}`);
    });
  }
};
