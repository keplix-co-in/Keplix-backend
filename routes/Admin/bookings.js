import express from 'express';
import { getBookingCounts, getCardsBookingsData } from '../../controllers/admin/bookingController.js';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
const router = express.Router();

router.get("/bookings/counts", authAdmin, authorizeAdmin, getBookingCounts);

router.get("/bookings", authAdmin, authorizeAdmin, getCardsBookingsData);

export default router;