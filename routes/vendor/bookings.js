import express from 'express';
import { getVendorBookings, updateBookingStatus } from '../../controllers/vendor/bookingController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { updateBookingStatusSchema } from '../../validators/vendor/bookingValidators.js';

const router = express.Router();

router.get('/bookings', protect, getVendorBookings);
router.patch('/bookings/:id', protect, validateRequest(updateBookingStatusSchema), updateBookingStatus);
router.put('/bookings/:id', protect, validateRequest(updateBookingStatusSchema), updateBookingStatus);

export default router;
