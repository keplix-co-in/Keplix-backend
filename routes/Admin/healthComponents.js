import express from 'express';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createHealthComponentSchema, updateHealthComponentSchema } from '../../validators/Admin/healthComponentValidator.js';
import {
  listHealthComponentsAdmin,
  createHealthComponent,
  updateHealthComponent,
} from '../../controllers/Admin/healthComponentController.js';

const router = express.Router();

router.get('/health-components', authAdmin, authorizeAdmin, listHealthComponentsAdmin);
router.post(
  '/health-components',
  authAdmin,
  authorizeAdmin,
  validateRequest(createHealthComponentSchema),
  createHealthComponent,
);
router.patch(
  '/health-components/:id',
  authAdmin,
  authorizeAdmin,
  validateRequest(updateHealthComponentSchema),
  updateHealthComponent,
);

export default router;
