import multer from 'multer';
import { uploadLocalFiles } from '../helper.js';
import path from 'path';

const HOME_UPLOAD_DIRECTORY = 'public';
/**
 *
 * @param {string} uploadDirectory
 * @returns {multer.StorageEngine}
 */
const developmentStorage = multer.diskStorage({
  destination: (req, file, callbackFn) => {
    // 1. Determine subfolder based on the file type
    let subFolder = 'documents'; // Default
    if (file.mimetype.startsWith('image/')) subFolder = 'images';
    else if (file.mimetype.startsWith('audio/')) subFolder = 'voices';
    else if (file.mimetype.startsWith('video/')) subFolder = 'videos';

    // 2. Build the path: public/uploads/images, etc.
    // uploadLocalFiles helper will mkdirSync(recursive: true) automatically
    const finalPath = uploadLocalFiles(`${HOME_UPLOAD_DIRECTORY}/uploads/${subFolder}`);

    callbackFn(null, finalPath);
  },

  filename: (req, file, callbackFn) => {
    let fileExtension = path.extname(file.originalname) || '';

    const filenameWithoutExtension = path
      .basename(file.originalname, fileExtension)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9.-]/g, '');

    const uniqueName = `${filenameWithoutExtension}-${Date.now()}-${Math.ceil(Math.random() * 1e5)}${fileExtension}`;

    callbackFn(null, uniqueName);
  },
});

export const upload = multer({
  storage: developmentStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});
