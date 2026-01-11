import express from 'express';
import { getFeedback, createFeedback } from '../../controllers/user/feedbackController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createFeedbackSchema } from '../../validators/user/feedbackValidators.js';

const router = express.Router();

router.get('/', protect, getFeedback);
router.post('/create', protect, validateRequest(createFeedbackSchema), createFeedback);

// Aliases
router.post('/create/', protect, validateRequest(createFeedbackSchema), createFeedback);

export default router;
