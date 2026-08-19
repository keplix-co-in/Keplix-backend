import express from 'express';
import { getVendorReviews, replyToReview } from '../../controllers/vendor/reviewController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

/**
 * Mounted at /interactions/api/vendor (app.js), alongside the vendor feedback,
 * interaction and notification routers.
 *
 * Every path here is therefore prefixed with `/reviews` explicitly. Previously
 * the list was registered at `/` — which claimed GET /interactions/api/vendor
 * itself, a path shared with three other routers — and the reply handler at
 * `/:id/reply`, which resolved to /interactions/api/vendor/:id/reply rather
 * than anything under /reviews, and additionally shadowed any single-segment
 * route the sibling routers registered.
 */

/**
 * @swagger
 * /interactions/api/vendor/reviews:
 *   get:
 *     summary: Get reviews for the logged-in vendor (scope comes from the token)
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: customer_id
 *         schema: { type: integer }
 *       - in: query
 *         name: service_id
 *         schema: { type: integer }
 *       - in: query
 *         name: date_from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: date_to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: min_rating
 *         schema: { type: integer, minimum: 1, maximum: 5 }
 *     responses:
 *       200:
 *         description: Paginated reviews. `filters` (dropdown options) is included on page 1 only.
 */
router.get('/reviews', protect, getVendorReviews);

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
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reply]
 *             properties:
 *               reply:
 *                 type: string
 *                 maxLength: 2000
 *     responses:
 *       200:
 *         description: Reply saved
 *       404:
 *         description: Review not found or not owned by this vendor
 */
router.post('/reviews/:id/reply', protect, replyToReview);

export default router;
