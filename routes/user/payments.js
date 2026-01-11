import express from 'express';
import { getUserPayments, createPaymentOrder, verifyPayment } from '../../controllers/user/paymentController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createPaymentSchema } from '../../validators/user/paymentValidators.js';

const router = express.Router();

router.post('/payments/order/create', protect, validateRequest(createPaymentSchema), createPaymentOrder);
router.post('/payments/verify', protect, verifyPayment);
router.get('/user/:user_id/payments', protect, getUserPayments);

// Aliases
router.post('/payments/order/create/', protect, validateRequest(createPaymentSchema), createPaymentOrder);
router.post('/payments/verify/', protect, verifyPayment);
router.get('/user/:user_id/payments/', protect, getUserPayments);

export default router;
