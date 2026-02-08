import { Router } from 'express';
import { statusController } from '../../controllers/index.js';
import { verifyJWT } from '../../middlewares/auth.middleware.js';
import { upload } from '../../middlewares/multer.middleware.js';

export const router = Router();

router.use(verifyJWT);

router.route('/feed').get(statusController.getStatusStoriesFeed);

router
  .route('/add-status/media/')
  .post(upload.fields([{ name: 'statusMedias' }]), statusController.postNewStatus);

router.route('/add-status/text/').post(statusController.postTextStatus);

router.route('/my-status').get(statusController.getUserStatusStories);

router.route('/:statusId/view').post(statusController.markStatusAsViewed);

router.route('/:statusId').delete(statusController.deleteUserStatusStories);

router.route('/cleanup/expired').delete(statusController.cleanupExpiredStatuses);
