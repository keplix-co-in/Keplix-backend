import express from 'express';
import { getVendorFeedback, createVendorFeedback } from '../../controllers/vendor/feedbackController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createFeedbackSchema } from '../../validators/user/feedbackValidators.js';

const router = express.Router();

/**
 * Mounted at /interactions/api/vendor (app.js), alongside the vendor reviews,
 * interaction and notification routers. Every path here is therefore
 * prefixed with `/feedback` explicitly.
 *
 * Previously `GET '/'` and `POST '/create'` had no such prefix: the GET
 * claimed `/interactions/api/vendor` itself -- a path shared with the
 * sibling routers -- and the POST resolved to `/interactions/api/vendor/create`
 * rather than the documented (and only alias actually reachable before this
 * fix) `/interactions/api/vendor/feedback/create`, so the real route never
 * matched the swagger doc or the create endpoint any client would guess from
 * the customer-side equivalent (`/interactions/api/feedback/create`).
 */

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
router.get('/feedback', protect, getVendorFeedback);

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
 *         description: Feedback submitted successfully
 */
// The Feedback model requires title/message/category (see prisma schema and
// the customer-side route this mirrors); the doc previously promised
// {comment, rating}, which createVendorFeedback (identical to the customer
// controller) never read, so posting the documented shape threw an unhandled
// Prisma validation error (500 "Server Error") instead of a clean 400. The
// validator here matches what the controller actually requires, same as the
// customer-side /interactions/api/feedback/create.
router.post('/feedback/create', protect, validateRequest(createFeedbackSchema), createVendorFeedback);

export default router;
