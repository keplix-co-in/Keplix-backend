import express from 'express';
import { getUserBookings, createBooking } from '../../controllers/user/bookingController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createBookingSchema } from '../../validators/user/bookingValidators.js';

const router = express.Router();

router.get('/bookings', protect, getUserBookings);
router.post('/bookings', protect, validateRequest(createBookingSchema), createBooking);

export default router;
