import express from 'express';
import { getFeedback, createFeedback } from '../../controllers/user/feedbackController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createFeedbackSchema } from '../../validators/user/feedbackValidators.js';

const router = express.Router();

/**
 * @swagger
 * /interactions/api/feedback:
 *   get:
 *     summary: Get user's feedback
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of user feedback
 *       500:
 *         description: Server Error
 */
router.get('/', protect, getFeedback);

/**
 * @swagger
 * /interactions/api/feedback/create:
 *   post:
 *     summary: Submit feedback
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - message
 *               - category
 *             properties:
 *               title:
 *                 type: string
 *               message:
 *                 type: string
 *               category:
 *                 type: string
 *     responses:
 *       201:
 *         description: Feedback submitted
 *       500:
 *         description: Server Error
 */
router.post('/create', protect, validateRequest(createFeedbackSchema), createFeedback);

// Aliases
router.post('/create/', protect, validateRequest(createFeedbackSchema), createFeedback);

export default router;
