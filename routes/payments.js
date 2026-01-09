import express from 'express';
import { createPaymentOrder, verifyPayment, getUserPayments, getVendorPayments } from '../controllers/paymentController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/payments/order/create', protect, createPaymentOrder);
router.post('/payments/verify', protect, verifyPayment);
router.get('/user/:user_id/payments', protect, getUserPayments);
router.get('/vendor/:vendor_id/payments', protect, getVendorPayments);

// Aliases
router.post('/payments/order/create/', protect, createPaymentOrder);
router.post('/payments/verify/', protect, verifyPayment);
router.get('/user/:user_id/payments/', protect, getUserPayments);
router.get('/vendor/:vendor_id/payments/', protect, getVendorPayments);


export default router;
