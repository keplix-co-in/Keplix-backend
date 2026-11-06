import express from 'express';
import { 
    getVendorPayments, 
    getVendorEarnings, 
    createVendorPaymentOrder, 
    verifyVendorPayment 
} from '../../controllers/vendor/paymentController.js';
// Security A-020 / SYS-003: every route here is vendor-only (per route, not
// router.use, because several vendor routers share the /service_api prefix
// with user routers). requireApprovedVendor gates money/job actions only.
import { vendorOnly, requireApprovedVendor } from '../../middleware/roleMiddleware.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createVendorPaymentOrderSchema, verifyVendorPaymentSchema } from '../../validators/vendor/paymentValidators.js';

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
router.get('/vendor/:vendor_id/payments', protect, vendorOnly, getVendorPayments);

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
router.get('/vendor/:vendor_id/earning', protect, vendorOnly, getVendorEarnings);

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
router.post('/vendor/payments/order/create', protect, vendorOnly, requireApprovedVendor, validateRequest(createVendorPaymentOrderSchema), createVendorPaymentOrder);

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
router.post('/vendor/payments/verify', protect, vendorOnly, requireApprovedVendor, validateRequest(verifyVendorPaymentSchema), verifyVendorPayment);

export default router;
