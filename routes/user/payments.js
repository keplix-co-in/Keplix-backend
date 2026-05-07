import express from 'express';
import {createPaymentOrder, verifyPayment, handleRazorpayWebhook } from '../../controllers/user/paymentController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createPaymentSchema, verifyPaymentSchema } from '../../validators/user/paymentValidators.js';

const router = express.Router();

/**
 * @swagger
 * /service_api/payments/razorpay-webhook:
 *   post:
 *     summary: Handle Razorpay webhook notifications
 *     tags: [User]
 *     responses:
 *       200:
 *         description: Webhook handled
 */
router.post('/payments/razorpay-webhook', handleRazorpayWebhook);

/**
 * @swagger
 * /service_api/payments/order/create:
 *   post:
 *     summary: Create a new Razorpay payment order
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bookingId:
 *                 type: string
 *               amount:
 *                 type: number
 *               currency:
 *                 type: string
 *     responses:
 *       200:
 *         description: Order created successfully
 */
router.post('/payments/order/create', protect , validateRequest(createPaymentSchema), createPaymentOrder);

/**
 * @swagger
 * /service_api/payments/verify:
 *   post:
 *     summary: Verify a Razorpay payment
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               razorpay_order_id:
 *                 type: string
 *               razorpay_payment_id:
 *                 type: string
 *               razorpay_signature:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment verified successfully
 */
router.post('/payments/verify', protect , validateRequest(verifyPaymentSchema), verifyPayment);

// Aliases
router.post('/payments/order/create/', validateRequest(createPaymentSchema), createPaymentOrder);
router.post('/payments/verify/', validateRequest(verifyPaymentSchema), verifyPayment);

export default router;
