import express from 'express';
import { getVendorBookings, updateBookingStatus, respondToServiceRequest, requestEarlyStart } from '../../controllers/vendor/bookingController.js';
// Security A-020 / SYS-003: every route here is vendor-only (per route, not
// router.use, because several vendor routers share the /service_api prefix
// with user routers). requireApprovedVendor gates money/job actions only.
import { vendorOnly, requireApprovedVendor } from '../../middleware/roleMiddleware.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { updateBookingStatusSchema, respondToServiceRequestSchema, requestEarlyStartSchema } from '../../validators/vendor/bookingValidators.js';
import {uploadSingle, uploadFieldss} from '../../middleware/uploadMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /service_api/vendor/{vendorId}/bookings:
 *   get:
 *     summary: Get all bookings for a specific vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of vendor bookings
 */
router.get('/:vendorId/bookings', protect, vendorOnly, getVendorBookings);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/respond:
 *   patch:
 *     summary: Accept or reject a service request
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Booking ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vendor_status
 *             properties:
 *               vendor_status:
 *                 type: string
 *                 enum: [accepted, rejected, declined]
 *     responses:
 *       200:
 *         description: Response recorded successfully
 */
router.patch('/bookings/:id/respond', protect, vendorOnly, requireApprovedVendor, validateRequest(respondToServiceRequestSchema), respondToServiceRequest);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/bookings/{id}/respond:
 *   patch:
 *     summary: Accept or reject a service request (with vendorId prefix)
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vendor_status
 *             properties:
 *               vendor_status:
 *                 type: string
 *                 enum: [accepted, rejected, declined]
 *     responses:
 *       200:
 *         description: Response recorded successfully
 */
router.patch('/:vendorId/bookings/:id/respond', protect, vendorOnly, requireApprovedVendor, validateRequest(respondToServiceRequestSchema), respondToServiceRequest);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/bookings/update/{id}:
 *   post:
 *     summary: Update booking status with proof images
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, confirmed, completed, cancelled, rejected]
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *     responses:
 *       200:
 *         description: Booking status updated successfully
 */
router.post('/:vendorId/bookings/update/:id', protect, vendorOnly, requireApprovedVendor, uploadFieldss([{ name: 'images', maxCount: 10 }]), (req, res, next) => {
  next();
}, validateRequest(updateBookingStatusSchema), updateBookingStatus);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/bookings/update/{id}:
 *   patch:
 *     summary: Update booking status (backward compatibility)
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, confirmed, completed, cancelled, rejected]
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *     responses:
 *       200:
 *         description: Booking status updated successfully
 */
router.patch('/:vendorId/bookings/update/:id', protect, vendorOnly, requireApprovedVendor, uploadFieldss([{ name: 'images', maxCount: 10 }]), (req, res, next) => {
  next(); // Keep PATCH for backward compatibility if needed, but prefer POST for files
}, validateRequest(updateBookingStatusSchema), updateBookingStatus);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/bookings/{id}/early-start:
 *   post:
 *     summary: Ask the customer whether the job can start earlier
 *     description: >
 *       Records the request and notifies the customer. Does NOT change the
 *       booking's status — only the customer's response can do that.
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               booking_time:
 *                 type: string
 *                 description: Earlier slot; defaults to the current half-hour.
 *               note:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ success, message }"
 *       400:
 *         description: Booking not eligible, or the time is not earlier
 *       404:
 *         description: Booking not found
 *       409:
 *         description: The earlier slot is already occupied
 */
router.post('/:vendorId/bookings/:id/early-start', protect, vendorOnly, requireApprovedVendor, validateRequest(requestEarlyStartSchema), requestEarlyStart);

export default router;
