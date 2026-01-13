import express from 'express';
import { getVendorFeedback, createVendorFeedback } from '../../controllers/vendor/feedbackController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', protect, getVendorFeedback);
router.post('/create', protect, createVendorFeedback);

// Aliases
router.get('/feedback', protect, getVendorFeedback);

export default router;
