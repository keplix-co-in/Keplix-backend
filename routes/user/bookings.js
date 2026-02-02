import express from 'express';
import { getUserBookings, getSingleBooking, createBooking, updateBooking, canProceedToPayment } from '../../controllers/user/bookingController.js';
import { confirmServiceCompletion, disputeServiceCompletion } from '../../controllers/user/serviceConfirmationController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { 
  createBookingSchema, 
  updateBookingSchema, 
  confirmServiceSchema, 
  disputeServiceSchema 
} from '../../validators/user/bookingValidators.js';

const router = express.Router();

import { getPaymentByBooking } from '../../controllers/user/bookingController.js';

// Matches GET /service_api/user/:userId/bookings
router.get('/:userId/bookings', protect, getUserBookings);

// Matches GET /service_api/user/:userId/bookings/:id (Get single booking)
router.get('/:userId/bookings/:id', protect, getSingleBooking);

// Matches GET /service_api/user/:userId/bookings/:id/can-pay (Check if vendor accepted)
router.get('/:userId/bookings/:id/can-pay', protect, canProceedToPayment);

// Matches GET /service_api/bookings/:bookingId/payment (fetch payment by bookingId)
router.get('/bookings/:bookingId/payment', protect, getPaymentByBooking);

// Matches POST /service_api/user/:userId/bookings/create
router.post('/:userId/bookings/create', protect, validateRequest(createBookingSchema), createBooking);

// Matches PUT /service_api/user/:userId/bookings/update/:id
router.put('/:userId/bookings/update/:id', protect, validateRequest(updateBookingSchema), updateBooking);

// CRITICAL ESCROW ENDPOINTS
// User confirms service completion → Triggers vendor payout
router.post('/:userId/bookings/:id/confirm', protect, validateRequest(confirmServiceSchema), confirmServiceCompletion);

// User disputes service → Blocks payout, requires admin review
router.post('/:userId/bookings/:id/dispute', protect, validateRequest(disputeServiceSchema), disputeServiceCompletion);

// Alias: Allow standard REST path if needed by other components
router.get('/bookings', protect, getUserBookings);
router.post('/bookings', protect, validateRequest(createBookingSchema), createBooking);

export default router;
