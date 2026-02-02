import express from 'express';
import { 
    getVendorPayments, 
    getVendorEarnings, 
    createVendorPaymentOrder, 
    verifyVendorPayment 
} from '../../controllers/vendor/paymentController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/vendor/:vendor_id/payments', protect, getVendorPayments);
router.get('/vendor/:vendor_id/earning', protect, getVendorEarnings);

// Mutation Routes for Vendor Payments (Paying the platform)
router.post('/vendor/payments/order/create', protect, createVendorPaymentOrder);
router.post('/vendor/payments/verify', protect, verifyVendorPayment);

export default router;
