import express from 'express';
import { getUserPayments, createPaymentOrder, verifyPayment } from '../../controllers/user/paymentController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.post('/payments/order/create', protect, createPaymentOrder);
router.post('/payments/verify', protect, verifyPayment);
router.get('/user/:user_id/payments', protect, getUserPayments);

// Aliases
router.post('/payments/order/create/', protect, createPaymentOrder);
router.post('/payments/verify/', protect, verifyPayment);
router.get('/user/:user_id/payments/', protect, getUserPayments);

export default router;
