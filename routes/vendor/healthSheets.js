import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { uploadAny } from '../../middleware/uploadMiddleware.js';
import { createHealthSheetSchema } from '../../validators/vendor/healthSheetValidators.js';
import {
  createHealthSheet,
  getHealthSheet,
  getHealthSheetForBooking,
  getHealthSheetForWalkInJob,
  listHealthComponents,
} from '../../controllers/vendor/healthSheetController.js';

const router = express.Router();

router.get('/health-components', protect, listHealthComponents);

/**
 * @swagger
 * /service_api/vendor/health-sheets:
 *   post:
 *     summary: Submit a Digital Vehicle Health Sheet for a Booking or a WalkInJob
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 */
router.post('/health-sheets', protect, uploadAny(), validateRequest(createHealthSheetSchema), createHealthSheet);

router.get('/health-sheets/:id', protect, getHealthSheet);
router.get('/bookings/:id/health-sheet', protect, getHealthSheetForBooking);
router.get('/walk-in-jobs/:id/health-sheet', protect, getHealthSheetForWalkInJob);

export default router;
