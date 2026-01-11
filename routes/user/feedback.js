import express from 'express';
import { getFeedback, createFeedback } from '../../controllers/user/feedbackController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', protect, getFeedback);
router.post('/create', protect, createFeedback);

// Aliases
router.post('/create/', protect, createFeedback);

export default router;
