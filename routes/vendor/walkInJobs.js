import express from 'express';
// Security A-020 / SYS-003: every route here is vendor-only (per route, not
// router.use, because several vendor routers share the /service_api prefix
// with user routers). requireApprovedVendor gates money/job actions only.
import { vendorOnly, requireApprovedVendor } from '../../middleware/roleMiddleware.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import {
  createWalkInJobSchema,
  updateWalkInJobSchema,
  updateWalkInJobStatusSchema,
} from '../../validators/vendor/walkInJobValidators.js';
import {
  createWalkInJob,
  listWalkInJobs,
  getWalkInJob,
  updateWalkInJob,
  updateWalkInJobStatus,
  resendWalkInJobNotification,
} from '../../controllers/vendor/walkInJobController.js';

const router = express.Router();

/**
 * @swagger
 * /service_api/vendor/walk-in-jobs:
 *   post:
 *     summary: Create a walk-in (offline) job for a customer with no Keplix account
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 */
router.post('/walk-in-jobs', protect, vendorOnly, requireApprovedVendor, validateRequest(createWalkInJobSchema), createWalkInJob);

router.get('/walk-in-jobs', protect, vendorOnly, listWalkInJobs);

router.get('/walk-in-jobs/:id', protect, vendorOnly, getWalkInJob);

router.patch('/walk-in-jobs/:id', protect, vendorOnly, requireApprovedVendor, validateRequest(updateWalkInJobSchema), updateWalkInJob);

router.patch(
  '/walk-in-jobs/:id/status',
  protect,
  vendorOnly,
  requireApprovedVendor,
  validateRequest(updateWalkInJobStatusSchema),
  updateWalkInJobStatus,
);

router.post('/walk-in-jobs/:id/notify', protect, vendorOnly, requireApprovedVendor, resendWalkInJobNotification);

export default router;
