import { v2 } from "cloudinary";
import { ApiError } from "../utils/ApiError.js";
import dotenv from "dotenv";
import { StatusCodes } from "http-status-codes";

dotenv.config();

v2.config({
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  cloud_name: process.env.CLOUDINARY_NAME,
});

/**
 * Uploads a file to Cloudinary.
 * Accepts either a file path (string) or an in-memory Buffer.
 *
 * @param {string | Buffer} fileSource
 * @param {string} folder
 */
const uploadFileToCloudinary = async (fileSource, folder) => {
  // ✅ Buffer path: pipe through upload_stream (used by memoryStorage uploads)
  if (Buffer.isBuffer(fileSource)) {
    return new Promise((resolve, reject) => {
      const uploadStream = v2.uploader.upload_stream(
        {
          resource_type: "auto",
          folder,
        },
        (error, result) => {
          if (error)
            reject(new ApiError(StatusCodes.BAD_REQUEST, error.message));
          else resolve(result);
        },
      );

      uploadStream.end(fileSource);
    });
  }

  // ✅ Path/URL string: existing behavior, unchanged
  return new Promise((resolve, reject) => {
    v2.uploader.upload(
      fileSource,
      {
        resource_type: "auto",
        folder,
      },
      (error, result) => {
        if (error) reject(new ApiError(StatusCodes.BAD_REQUEST, error.message));
        else resolve(result);
      },
    );
  });
};

const deleteFileFromCloudinary = async (public_id) => {
  try {
    const deletedResource = await v2.uploader.destroy(
      public_id,
      (error, result) => {
        if (error) {
          new ApiError(StatusCodes.BAD_REQUEST, error.message);
        } else {
          return result;
        }
      },
    );

    if (deletedResource.result === "not found") {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "Public ID not found. Provide a valid publicId.",
      );
    }

    if (deletedResource.result !== "ok") {
      throw new ApiError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        "Error while deleting existing file. Try again.",
      );
    }
  } catch (error) {
    throw error instanceof ApiError
      ? error
      : new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, error.message);
  }
};

export { uploadFileToCloudinary, deleteFileFromCloudinary };
