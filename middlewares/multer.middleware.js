import multer from 'multer';
import { uploadLocalFiles } from '../helper.js';

const HOME_UPLOAD_DIRECTORY = 'public';

const devMode = process.env.NODE_ENV;
const messagingStorage = multer.memoryStorage();

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
    let fileExtension = '';
    if (file.originalname.split('.').length > 1) {
      fileExtension = file.originalname.substring(file.originalname.lastIndexOf('.'));
    }

    const filenameWithoutExtension = file.originalname
      .toLowerCase()
      .split(' ')
      .join('-')
      ?.split('.')[0];

    callbackFn(
      null,
      filenameWithoutExtension + Date.now() + Math.ceil(Math.random() * 1e5) + fileExtension,
    );
  },
});

export const upload = multer({
  storage: devMode === 'development' ? developmentStorage : messagingStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});
