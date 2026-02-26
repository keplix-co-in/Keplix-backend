import express from 'express';
import { getBookingData } from '../../controllers/admin/bookingController.js';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
const router = express.Router();

router.get("/bookings", authAdmin, authorizeAdmin, getBookingData)

export default router;