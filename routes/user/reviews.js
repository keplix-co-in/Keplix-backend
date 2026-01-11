import express from 'express';
import { getReviews, createReview } from '../../controllers/user/reviewController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/reviews', protect, getReviews);
router.post('/reviews/create', protect, createReview);

// Aliases
router.get('/reviews/', protect, getReviews);
router.post('/reviews/create/', protect, createReview);

export default router;
