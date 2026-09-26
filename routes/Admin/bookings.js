import express from 'express';
import { getBookingMetrics, getBookings, forceCompleteBooking, resolveDisputeForCustomer } from '../../controllers/Admin/bookingController.js';
import { authAdmin, authorizeAdmin, authorizeSuperAdmin } from '../../middleware/authAdminMiddleware.js';
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
// Overrides the normal completion state machine and can trigger a payout --
// super_admin only (audit #108).
router.post("/bookings/:id/force-complete", authAdmin, authorizeAdmin, authorizeSuperAdmin, forceCompleteBooking);

/**
 * @swagger
 * /admin/bookings/{id}/dispute/resolve:
 *   post:
 *     summary: Resolve a disputed booking in the customer's favour (cancels the booking; refund is a separate action)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
// The other half of dispute resolution force-complete didn't cover (audit
// #76) -- super_admin only, same reasoning as force-complete above.
router.post("/bookings/:id/dispute/resolve", authAdmin, authorizeAdmin, authorizeSuperAdmin, resolveDisputeForCustomer);

export default router;