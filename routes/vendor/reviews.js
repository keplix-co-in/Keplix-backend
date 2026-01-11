import express from 'express';
import { getVendorReviews, replyToReview } from '../../controllers/vendor/reviewController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', protect, getVendorReviews);
router.post('/:id/reply', protect, replyToReview);

// Aliases (if needed)
router.get('/reviews', protect, getVendorReviews);

export default router;
