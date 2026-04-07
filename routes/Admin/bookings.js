import express from 'express';
import { getBookingMetrics, getBookings } from '../../controllers/Admin/bookingController.js';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
const router = express.Router();

router.get("/bookings/counts", authAdmin, authorizeAdmin, getBookingMetrics);

router.get("/bookings", authAdmin, authorizeAdmin, getBookings);

export default router;