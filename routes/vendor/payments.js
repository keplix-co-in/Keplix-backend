import express from 'express';
import { getVendorPayments, getVendorEarnings } from '../../controllers/vendor/paymentController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/vendor/:vendor_id/payments', protect, getVendorPayments);
router.get('/vendor/:vendor_id/earning', protect, getVendorEarnings);

// Aliases
router.get('/vendor/:vendor_id/payments/', protect, getVendorPayments);

export default router;
