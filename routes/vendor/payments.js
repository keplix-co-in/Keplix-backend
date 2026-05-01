import express from 'express';
import { 
    getVendorPayments, 
    getVendorEarnings, 
    createVendorPaymentOrder, 
    verifyVendorPayment 
} from '../../controllers/vendor/paymentController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /service_api/vendor/{vendor_id}/payments:
 *   get:
 *     summary: Get all payments for a vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendor_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of payments
 */
router.get('/vendor/:vendor_id/payments', protect, getVendorPayments);

/**
 * @swagger
 * /service_api/vendor/{vendor_id}/earning:
 *   get:
 *     summary: Get earnings summary for a vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendor_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Earnings summary
 */
router.get('/vendor/:vendor_id/earning', protect, getVendorEarnings);

/**
 * @swagger
 * /service_api/vendor/payments/order/create:
 *   post:
 *     summary: Create a payment order (e.g., for platform fees)
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: number
 *               currency:
 *                 type: string
 *                 default: INR
 *     responses:
 *       201:
 *         description: Order created successfully
 */
router.post('/vendor/payments/order/create', protect, createVendorPaymentOrder);

/**
 * @swagger
 * /service_api/vendor/payments/verify:
 *   post:
 *     summary: Verify a payment
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - razorpay_order_id
 *               - razorpay_payment_id
 *               - razorpay_signature
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
router.post('/vendor/payments/verify', protect, verifyVendorPayment);

export default router;
