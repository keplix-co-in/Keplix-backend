import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { vendorOnly, requireApprovedVendor } from '../../middleware/roleMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { subscriptionPaymentLimiter } from '../../middleware/rateLimitMiddleware.js';
import { createSubscriptionOrderSchema, verifySubscriptionSchema } from '../../validators/subscriptionValidators.js';
import { getPlans, getMe, createOrder, verify, getPayments } from '../../controllers/vendor/subscriptionController.js';

const router = express.Router();

// Garage subscriptions (owner decision 2026-11-22). Mounted at /subscriptions.
router.get('/plans', getPlans); // public
router.get('/me', protect, vendorOnly, requireApprovedVendor, getMe);
router.post('/order', protect, vendorOnly, requireApprovedVendor, subscriptionPaymentLimiter, validateRequest(createSubscriptionOrderSchema), createOrder);
router.post('/verify', protect, vendorOnly, requireApprovedVendor, subscriptionPaymentLimiter, validateRequest(verifySubscriptionSchema), verify);
router.get('/payments', protect, vendorOnly, requireApprovedVendor, getPayments);

export default router;
