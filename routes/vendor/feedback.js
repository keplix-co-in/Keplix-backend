import express from 'express';
import { getVendorFeedback, createVendorFeedback } from '../../controllers/vendor/feedbackController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /interactions/api/vendor/feedback:
 *   get:
 *     summary: Get all feedback for the logged-in vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of feedback
 */
router.get('/', protect, getVendorFeedback);

/**
 * @swagger
 * /interactions/api/vendor/feedback/create:
 *   post:
 *     summary: Submit feedback as a vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - comment
 *             properties:
 *               comment:
 *                 type: string
 *               rating:
 *                 type: number
 *     responses:
 *       201:
 *         description: Feedback submitted successfully
 */
router.post('/create', protect, createVendorFeedback);

// Aliases
router.get('/feedback', protect, getVendorFeedback);

export default router;
