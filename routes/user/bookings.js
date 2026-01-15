import express from 'express';
import { getUserBookings, createBooking } from '../../controllers/user/bookingController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createBookingSchema } from '../../validators/user/bookingValidators.js';

const router = express.Router();

// Matches GET /service_api/user/:userId/bookings
router.get('/:userId/bookings', protect, getUserBookings);

// Matches POST /service_api/user/:userId/bookings/create
router.post('/:userId/bookings/create', protect, validateRequest(createBookingSchema), createBooking);

// Alias: Allow standard REST path if needed by other components
router.get('/bookings', protect, getUserBookings);
router.post('/bookings', protect, validateRequest(createBookingSchema), createBooking);

export default router;
