import express from 'express';
import { viewBill } from '../../controllers/public/billController.js';
import { publicJobLookupLimiter } from '../../middleware/rateLimitMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /bills/{id}/view:
 *   get:
 *     summary: Printable final bill (HTML), authorised by a short-lived signed token
 *     description: The token (query t) is issued by POST /service_api/user|vendor/bookings/{id}/bill-link and expires after 15 minutes.
 *     tags: [Pricing v2]
 */
router.get('/:id/view', publicJobLookupLimiter, viewBill);

export default router;
