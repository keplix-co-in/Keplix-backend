import express from 'express';
import {createPaymentOrder, verifyPayment, handleRazorpayWebhook } from '../../controllers/user/paymentController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createPaymentSchema, verifyPaymentSchema } from '../../validators/user/paymentValidators.js';

const router = express.Router();

// Webhook endpoint (NO AUTH - Razorpay calls this directly)
router.post('/payments/razorpay-webhook', handleRazorpayWebhook);

// TEMPORARY: Auth removed for testing - ADD BACK BEFORE PRODUCTION!
router.post('/payments/order/create', protect , validateRequest(createPaymentSchema), createPaymentOrder);
router.post('/payments/verify', protect , validateRequest(verifyPaymentSchema), verifyPayment);
// router.get('/user/:user_id/payments', protect, getUserPayments);

// Aliases
router.post('/payments/order/create/', validateRequest(createPaymentSchema), createPaymentOrder);
router.post('/payments/verify/', validateRequest(verifyPaymentSchema), verifyPayment);
// router.get('/user/:user_id/payments/', protect, getUserPayments);

export default router;
