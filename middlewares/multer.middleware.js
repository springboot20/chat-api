import multer from "multer";
import { uploadLocalFiles } from "../helper.js";
import path from "path";

const HOME_UPLOAD_DIRECTORY = "public";
const isProduction = process.env.NODE_ENV === "production";

const developmentStorage = multer.diskStorage({
  destination: (req, file, callbackFn) => {
    let subFolder = "documents";
    if (file.mimetype.startsWith("image/")) subFolder = "images";
    else if (file.mimetype.startsWith("audio/")) subFolder = "voices";
    else if (file.mimetype.startsWith("video/")) subFolder = "videos";

    const finalPath = uploadLocalFiles(
      `${HOME_UPLOAD_DIRECTORY}/uploads/${subFolder}`,
    );

    callbackFn(null, finalPath);
  },

  filename: (req, file, callbackFn) => {
    let fileExtension = path.extname(file.originalname) || "";

    const filenameWithoutExtension = path
      .basename(file.originalname, fileExtension)
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9.-]/g, "");

    const uniqueName = `${filenameWithoutExtension}-${Date.now()}-${Math.ceil(Math.random() * 1e5)}${fileExtension}`;

    callbackFn(null, uniqueName);
  },
});

// ✅ Production: buffer in memory, no disk writes, works on serverless
const memoryStorage = multer.memoryStorage();

// ✅ Pick the right engine automatically based on environment
const activeStorage = isProduction ? memoryStorage : developmentStorage;

export const upload = multer({
  storage: activeStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

export const uploadAvatarImage = multer({
  storage: activeStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed for avatar"), false);
    }
    cb(null, true);
  },
});
