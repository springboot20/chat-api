import multer from 'multer';

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, './public/images');
  },
  filename: (req, file, callback) => {
    let fileExtension = '';
    if (file.originalname.split('.').length > 0) {
      fileExtension = file.originalname.substring(file.originalname.lastIndexOf('.') + 1);
    }

    const filenameWithoutExtension = file.originalname
      .toLowerCase()
      .split(' ')
      .join('-')
      ?.split('.')[0];

    callback(
      null,
      `${filenameWithoutExtension}${Date.now()}${Math.ceil(Math.random() * 1e6)}.${fileExtension}`
    );
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1000 * 1000,
  },
});

export { upload };
