import express from 'express';
// Security A-020 / SYS-003: every route here is vendor-only (per route, not
// router.use, because several vendor routers share the /service_api prefix
// with user routers). requireApprovedVendor gates money/job actions only.
import { vendorOnly, requireApprovedVendor } from '../../middleware/roleMiddleware.js';
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

router.get('/health-components', protect, vendorOnly, listHealthComponents);

/**
 * @swagger
 * /service_api/vendor/health-sheets:
 *   post:
 *     summary: Submit a Digital Vehicle Health Sheet for a Booking or a WalkInJob
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 */
router.post('/health-sheets', protect, vendorOnly, requireApprovedVendor, uploadAny(), validateRequest(createHealthSheetSchema), createHealthSheet);

router.get('/health-sheets/:id', protect, vendorOnly, getHealthSheet);
router.get('/bookings/:id/health-sheet', protect, vendorOnly, getHealthSheetForBooking);
router.get('/walk-in-jobs/:id/health-sheet', protect, vendorOnly, getHealthSheetForWalkInJob);

export default router;
