import express from 'express';
import { getVendorBookings, updateBookingStatus } from '../../controllers/vendor/bookingController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/bookings', protect, getVendorBookings);
router.patch('/bookings/:id', protect, updateBookingStatus);
// Parity: Django sometimes uses PUT for updates or separate endpoints
router.put('/bookings/:id', protect, updateBookingStatus);

export default router;
