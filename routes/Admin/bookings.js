import express from 'express';
import { getBookingMetrics, getBookings } from '../../controllers/Admin/bookingController.js';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
const router = express.Router();

/**
 * @swagger
 * /admin/bookings/counts:
 *   get:
 *     summary: Get booking metrics and counts
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Booking metrics retrieved successfully
 */
router.get("/bookings/counts", authAdmin, authorizeAdmin, getBookingMetrics);

/**
 * @swagger
 * /admin/bookings:
 *   get:
 *     summary: Get all bookings
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bookings retrieved successfully
 */
router.get("/bookings", authAdmin, authorizeAdmin, getBookings);

export default router;