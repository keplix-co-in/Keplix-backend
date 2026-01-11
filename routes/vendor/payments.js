import express from 'express';
import { getVendorPayments } from '../../controllers/vendor/paymentController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/vendor/:vendor_id/payments', protect, getVendorPayments);

// Aliases
router.get('/vendor/:vendor_id/payments/', protect, getVendorPayments);

export default router;
