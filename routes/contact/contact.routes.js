import { Router } from 'express';
import { contactController } from '../../controllers/index.js';

import { verifyJWT } from '../../middlewares/auth.middleware.js';

export const router = Router();

router.use(verifyJWT);

router.route('/').get(contactController.getMyContacts);

router.route('/suggestions').get(contactController.getSuggestedFriends);

router.route('/add').post(contactController.addToContact);

router.route('/block/:contactId').patch(contactController.toggleBlockContact);

router.route('/blocked-list').get(contactController.getBlockedContacts);
