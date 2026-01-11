import express from 'express';
import { getReviews, createReview } from '../../controllers/user/reviewController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createReviewSchema } from '../../validators/user/reviewValidators.js';

const router = express.Router();

router.get('/reviews', protect, getReviews);
router.post('/reviews/create', protect, validateRequest(createReviewSchema), createReview);

// Aliases
router.get('/reviews/', protect, getReviews);
router.post('/reviews/create/', protect, validateRequest(createReviewSchema), createReview);

export default router;
