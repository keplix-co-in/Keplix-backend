import express from 'express';
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
router.post('/walk-in-jobs', protect, validateRequest(createWalkInJobSchema), createWalkInJob);

router.get('/walk-in-jobs', protect, listWalkInJobs);

router.get('/walk-in-jobs/:id', protect, getWalkInJob);

router.patch('/walk-in-jobs/:id', protect, validateRequest(updateWalkInJobSchema), updateWalkInJob);

router.patch(
  '/walk-in-jobs/:id/status',
  protect,
  validateRequest(updateWalkInJobStatusSchema),
  updateWalkInJobStatus,
);

router.post('/walk-in-jobs/:id/notify', protect, resendWalkInJobNotification);

export default router;
