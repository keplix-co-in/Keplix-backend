import express from 'express';
<<<<<<< HEAD
import { getBookingMetrics, getBookings } from '../../controllers/Admin/bookingController.js';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
const router = express.Router();

router.get("/bookings/counts", authAdmin, authorizeAdmin, getBookingMetrics);

router.get("/bookings", authAdmin, authorizeAdmin, getBookings);

=======
import { getBookingMetrics, getBookings, forceCompleteBooking } from '../../controllers/Admin/bookingController.js';
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

/**
 * @swagger
 * /admin/bookings/{id}/force-complete:
 *   post:
 *     summary: Force-complete a booking, bypassing the mandatory health-sheet gate
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.post("/bookings/:id/force-complete", authAdmin, authorizeAdmin, forceCompleteBooking);

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
export default router;