import express from 'express';
import { getUserBookings, getVendorBookings, createBooking, updateBookingStatus } from '../controllers/bookingController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/user/bookings', protect, getUserBookings);
router.get('/vendor/bookings', protect, getVendorBookings);
router.post('/bookings', protect, createBooking);
router.patch('/bookings/:id', protect, updateBookingStatus);
// Support POST limit for updates (sometimes used by frontend)
router.post('/bookings/:id', protect, updateBookingStatus);


// Aliases
router.get('/user/bookings/', protect, getUserBookings);
router.get('/vendor/bookings/', protect, getVendorBookings);
router.post('/bookings/', protect, createBooking);

export default router;
