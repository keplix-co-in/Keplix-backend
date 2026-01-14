import express from 'express';
import { getVendorBookings, updateBookingStatus } from '../../controllers/vendor/bookingController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { updateBookingStatusSchema } from '../../validators/vendor/bookingValidators.js';

const router = express.Router();

// Matches GET /service_api/vendor/:vendorId/bookings
router.get('/:vendorId/bookings', protect, getVendorBookings);

// Matches PUT /service_api/vendor/:vendorId/bookings/update/:id
router.put('/:vendorId/bookings/update/:id', protect, validateRequest(updateBookingStatusSchema), updateBookingStatus);
router.patch('/:vendorId/bookings/update/:id', protect, validateRequest(updateBookingStatusSchema), updateBookingStatus);

export default router;
