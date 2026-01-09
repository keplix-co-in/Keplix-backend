import express from 'express';
import { getUserBookings, createBooking } from '../../controllers/user/bookingController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/bookings', protect, getUserBookings);
router.post('/bookings', protect, createBooking);

export default router;
