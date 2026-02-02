import express from 'express';
import { getVendorBookings, updateBookingStatus, respondToServiceRequest } from '../../controllers/vendor/bookingController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { updateBookingStatusSchema } from '../../validators/vendor/bookingValidators.js';
import upload from '../../middleware/uploadMiddleware.js';

const router = express.Router();

// Matches GET /service_api/vendor/:vendorId/bookings
router.get('/:vendorId/bookings', protect, getVendorBookings);

// Matches PATCH /service_api/vendor/:vendorId/bookings/:id/respond (accept/reject request)
router.patch('/:vendorId/bookings/:id/respond', protect, respondToServiceRequest);

// Matches PATCH /service_api/vendor/:vendorId/bookings/update/:id
// Changed to POST to avoid potential network issues with PATCH+Multipart on some clients
router.post('/:vendorId/bookings/update/:id', protect, upload.array('images'), (req, res, next) => {
  next();
}, validateRequest(updateBookingStatusSchema), updateBookingStatus);
router.patch('/:vendorId/bookings/update/:id', protect, upload.array('images'), (req, res, next) => {
  next(); // Keep PATCH for backward compatibility if needed, but prefer POST for files
}, validateRequest(updateBookingStatusSchema), updateBookingStatus);

export default router;
