import express from 'express';
// Security A-021: platform settings (commission, fees) and vendor approval
// are super_admin-only; a regular admin account must not change who gets
// paid or how much.
import { authAdmin, authorizeAdmin, authorizeSuperAdmin } from '../../middleware/authAdminMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { updatePlatformSettingsSchema } from '../../validators/Admin/platformSettingsValidator.js';
import {
  getPlatformSettingsAdmin,
  updatePlatformSettingsAdmin,
} from '../../controllers/Admin/platformSettingsController.js';

const router = express.Router();

router.get('/platform-settings', authAdmin, authorizeAdmin, authorizeSuperAdmin, getPlatformSettingsAdmin);
router.patch(
  '/platform-settings',
  authAdmin,
  authorizeAdmin,
  authorizeSuperAdmin,
  validateRequest(updatePlatformSettingsSchema),
  updatePlatformSettingsAdmin,
);

export default router;
