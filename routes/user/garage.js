import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { claimRequestLimiter } from '../../middleware/rateLimitMiddleware.js';
import { claimRequestSchema, claimVerifySchema } from '../../validators/user/garageValidators.js';
import {
  listVehicles,
  getVehicle,
  getHistory,
  getHealthSheetForUser,
  claimRequest,
  claimVerify,
} from '../../controllers/user/garageController.js';

const router = express.Router();

router.get('/garage/vehicles', protect, listVehicles);
router.get('/garage/vehicles/:id', protect, getVehicle);
router.get('/garage/history', protect, getHistory);
router.get('/garage/health-sheets/:id', protect, getHealthSheetForUser);

router.post(
  '/garage/claim/request',
  protect,
  claimRequestLimiter,
  validateRequest(claimRequestSchema),
  claimRequest,
);
router.post('/garage/claim/verify', protect, validateRequest(claimVerifySchema), claimVerify);

export default router;
