import express from 'express';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { updatePlatformSettingsSchema } from '../../validators/Admin/platformSettingsValidator.js';
import {
  getPlatformSettingsAdmin,
  updatePlatformSettingsAdmin,
} from '../../controllers/Admin/platformSettingsController.js';

const router = express.Router();

router.get('/platform-settings', authAdmin, authorizeAdmin, getPlatformSettingsAdmin);
router.patch(
  '/platform-settings',
  authAdmin,
  authorizeAdmin,
  validateRequest(updatePlatformSettingsSchema),
  updatePlatformSettingsAdmin,
);

export default router;
