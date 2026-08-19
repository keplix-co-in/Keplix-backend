import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { claimRequestLimiter } from '../../middleware/rateLimitMiddleware.js';
import {
  claimRequestSchema,
  claimVerifySchema,
  createVehicleSchema,
  updateVehicleSchema,
} from '../../validators/user/garageValidators.js';
import {
  listVehicles,
  getVehicle,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  getHistory,
  getActiveJobs,
  getHealthSheetForUser,
  claimRequest,
  claimVerify,
} from '../../controllers/user/garageController.js';

const router = express.Router();

router.get('/garage/vehicles', protect, listVehicles);
router.post('/garage/vehicles', protect, validateRequest(createVehicleSchema), createVehicle);
router.get('/garage/vehicles/:id', protect, getVehicle);
router.patch('/garage/vehicles/:id', protect, validateRequest(updateVehicleSchema), updateVehicle);
router.delete('/garage/vehicles/:id', protect, deleteVehicle);
router.get('/garage/history', protect, getHistory);
router.get('/garage/health-sheets/:id', protect, getHealthSheetForUser);

// Registered outside the /garage/* namespace to match the spec's literal path
// (§4.2: GET /api/v1/user/jobs/active).
router.get('/jobs/active', protect, getActiveJobs);

router.post(
  '/garage/claim/request',
  protect,
  claimRequestLimiter,
  validateRequest(claimRequestSchema),
  claimRequest,
);
router.post('/garage/claim/verify', protect, validateRequest(claimVerifySchema), claimVerify);

export default router;
