import express from 'express';
import { getReviews, createReview, deleteReview } from '../../controllers/user/reviewController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createReviewSchema } from '../../validators/user/reviewValidators.js';

const router = express.Router();

/**
 * @swagger
 * /interactions/api/reviews:
 *   get:
 *     summary: Get reviews
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of reviews
 */
router.get('/reviews', protect, getReviews);

/**
 * @swagger
 * /interactions/api/reviews/create:
 *   post:
 *     summary: Create a review
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bookingId:
 *                 type: string
 *               rating:
 *                 type: number
 *               comment:
 *                 type: string
 *     responses:
 *       201:
 *         description: Review created
 */
router.post('/reviews/create', protect, validateRequest(createReviewSchema), createReview);

/**
 * @swagger
 * /interactions/api/reviews/{id}:
 *   delete:
 *     summary: Delete a review
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Review deleted
 */
router.delete('/reviews/:id', protect, deleteReview);

// Aliases
router.get('/reviews/', protect, getReviews);
router.post('/reviews/create/', protect, validateRequest(createReviewSchema), createReview);

export default router;
