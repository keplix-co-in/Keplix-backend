import express from 'express';
import { getVendorReviews, replyToReview } from '../../controllers/vendor/reviewController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /interactions/api/vendor/reviews:
 *   get:
 *     summary: Get all reviews for the logged-in vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of reviews
 */
router.get('/', protect, getVendorReviews);

/**
 * @swagger
 * /interactions/api/vendor/reviews/{id}/reply:
 *   post:
 *     summary: Reply to a review
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Review ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reply
 *             properties:
 *               reply:
 *                 type: string
 *     responses:
 *       200:
 *         description: Reply posted successfully
 */
router.post('/:id/reply', protect, replyToReview);

// Aliases (if needed)
router.get('/reviews', protect, getVendorReviews);

export default router;
