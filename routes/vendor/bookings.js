import express from 'express';
import { getVendorBookings, updateBookingStatus, respondToServiceRequest, requestEarlyStart } from '../../controllers/vendor/bookingController.js';
// Security A-020 / SYS-003: every route here is vendor-only (per route, not
// router.use, because several vendor routers share the /service_api prefix
// with user routers). requireApprovedVendor gates money/job actions only.
import { vendorOnly, requireApprovedVendor } from '../../middleware/roleMiddleware.js';
import { photoUploadPrecheck } from '../../middleware/photoUploadPrecheck.js';
import { vendorPhotoUploadLimiter } from '../../middleware/rateLimitMiddleware.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { updateBookingStatusSchema, respondToServiceRequestSchema, requestEarlyStartSchema } from '../../validators/vendor/bookingValidators.js';
import {uploadSingle, uploadFieldss} from '../../middleware/uploadMiddleware.js';
import {
  getVendorBookingPricing,
  vendorCheckIn,
  vendorStartInspection,
  vendorStartWork,
  vendorCompleteWork,
  vendorRequestExtraWork,
  vendorIssueFinalBill,
  vendorVoidFinalBill,
  vendorAddPhotos,
  vendorPartsUsed,
  vendorCustomerContact,
  vendorBillLink,
} from '../../controllers/vendor/pricingController.js';
import { getBookingEarnings, getEarningsSummary } from '../../controllers/vendor/earningsController.js';
import { checkInSchema, extraWorkSchema, voidBillSchema, partsUsedSchema } from '../../validators/pricingV2Validators.js';

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

// ---- Pricing v2 workshop flow (docs/PRICING_V2_API.md sections 3-4) ----

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/pricing:
 *   get:
 *     summary: Pricing v2 state of a booking
 *     description: Quote, job progress, extra-work requests, final bill, running total and the can flags for the vendor. A legacy booking returns {flow: legacy}.
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *     responses:
 *       200:
 *         description: Pricing object
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this vendor's booking (FORBIDDEN)
 *       404:
 *         description: Booking not found
 */
router.get('/bookings/:id/pricing', protect, vendorOnly, requireApprovedVendor, getVendorBookingPricing);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/check-in:
 *   post:
 *     summary: Check the car in
 *     description: Allowed when the booking is accepted and confirmed/scheduled (or in_progress with no check-in yet). Moves the booking to in_progress.
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               odometer_km:
 *                 type: integer
 *               fuel_level:
 *                 type: string
 *                 enum: [empty, quarter, half, three_quarter, full]
 *               condition_note:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: The updated pricing object (same shape as GET pricing)
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this vendor's booking (FORBIDDEN)
 *       404:
 *         description: Booking not found
 *       409:
 *         description: Not allowed in the current state (NOT_V2, INVALID_STATE, NOT_CHECKED_IN, BILL_EXISTS, ...)
 */
router.post('/bookings/:id/check-in', protect, vendorOnly, requireApprovedVendor, validateRequest(checkInSchema), vendorCheckIn);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/inspection/start:
 *   post:
 *     summary: Start the inspection
 *     description: Needs check-in. Idempotent.
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *     responses:
 *       200:
 *         description: The updated pricing object (same shape as GET pricing)
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this vendor's booking (FORBIDDEN)
 *       404:
 *         description: Booking not found
 *       409:
 *         description: Not allowed in the current state (NOT_V2, INVALID_STATE, NOT_CHECKED_IN, BILL_EXISTS, ...)
 */
router.post('/bookings/:id/inspection/start', protect, vendorOnly, requireApprovedVendor, vendorStartInspection);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/work/start:
 *   post:
 *     summary: Start the work
 *     description: Needs check-in. Idempotent.
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *     responses:
 *       200:
 *         description: The updated pricing object (same shape as GET pricing)
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this vendor's booking (FORBIDDEN)
 *       404:
 *         description: Booking not found
 *       409:
 *         description: Not allowed in the current state (NOT_V2, INVALID_STATE, NOT_CHECKED_IN, BILL_EXISTS, ...)
 */
router.post('/bookings/:id/work/start', protect, vendorOnly, requireApprovedVendor, vendorStartWork);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/work/complete:
 *   post:
 *     summary: Mark the work complete
 *     description: Needs work started (WORK_NOT_STARTED otherwise). Idempotent. Does not change the booking status.
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *     responses:
 *       200:
 *         description: The updated pricing object (same shape as GET pricing)
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this vendor's booking (FORBIDDEN)
 *       404:
 *         description: Booking not found
 *       409:
 *         description: Not allowed in the current state (NOT_V2, INVALID_STATE, NOT_CHECKED_IN, BILL_EXISTS, ...)
 */
router.post('/bookings/:id/work/complete', protect, vendorOnly, requireApprovedVendor, vendorCompleteWork);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/extra-work:
 *   post:
 *     summary: Ask the customer to approve extra work
 *     description: After check-in, before a bill. Removal items need quote_line_id; their amount is copied from that quote line. supersedes_id replaces a pending or partly answered request (approved items stay approved).
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason, items]
 *             properties:
 *               reason:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 300
 *               supersedes_id:
 *                 type: integer
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 20
 *                 items:
 *                   type: object
 *                   required: [kind]
 *                   properties:
 *                     kind:
 *                       type: string
 *                       enum: [labour, part, removal]
 *                     name:
 *                       type: string
 *                     qty:
 *                       type: number
 *                     unit_price:
 *                       type: number
 *                     quote_line_id:
 *                       type: integer
 *     responses:
 *       201:
 *         description: Request created; pricing object plus request_id
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this vendor's booking (FORBIDDEN)
 *       404:
 *         description: Booking not found
 *       409:
 *         description: Not allowed in the current state (NOT_V2, INVALID_STATE, NOT_CHECKED_IN, BILL_EXISTS, ...)
 */
router.post('/bookings/:id/extra-work', protect, vendorOnly, requireApprovedVendor, validateRequest(extraWorkSchema), vendorRequestExtraWork);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/final-bill:
 *   post:
 *     summary: Issue the final bill
 *     description: After check-in. Idempotent: an existing issued/paid bill is returned with 200. Pending items lapse and are listed in lapsed_item_ids.
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *     responses:
 *       200:
 *         description: Bill already existed; pricing object with lapsed_item_ids []
 *       201:
 *         description: Bill issued; pricing object plus lapsed_item_ids
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this vendor's booking (FORBIDDEN)
 *       404:
 *         description: Booking not found
 *       409:
 *         description: Not allowed in the current state (NOT_V2, INVALID_STATE, NOT_CHECKED_IN, BILL_EXISTS, ...)
 */
router.post('/bookings/:id/final-bill', protect, vendorOnly, requireApprovedVendor, vendorIssueFinalBill);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/final-bill/void:
 *   post:
 *     summary: Void the issued bill
 *     description: Only while issued and unpaid (BILL_PAID otherwise). A new bill can then be issued.
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 300
 *     responses:
 *       200:
 *         description: The updated pricing object (same shape as GET pricing)
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this vendor's booking (FORBIDDEN)
 *       404:
 *         description: Booking not found
 *       409:
 *         description: Not allowed in the current state (NOT_V2, INVALID_STATE, NOT_CHECKED_IN, BILL_EXISTS, ...)
 */
router.post('/bookings/:id/final-bill/void', protect, vendorOnly, requireApprovedVendor, validateRequest(voidBillSchema), vendorVoidFinalBill);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/photos:
 *   post:
 *     summary: Attach job photos (check-in or an extra-work request)
 *     description: multipart/form-data. Field photos (up to 10 images), text field kind (check_in | extra_work), request_id (extra_work only, an open request). Needs check-in. Returns the updated pricing object (201).
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 */
router.post('/bookings/:id/photos', protect, vendorOnly, requireApprovedVendor, vendorPhotoUploadLimiter, photoUploadPrecheck, uploadFieldss([{ name: 'photos', maxCount: 10 }]), vendorAddPhotos);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/parts-used:
 *   post:
 *     summary: Record the parts used (job timeline note)
 *     description: Body {note}. Needs check-in. Returns the updated pricing object (201); notes appear in job.parts_used.
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 */
router.post('/bookings/:id/parts-used', protect, vendorOnly, requireApprovedVendor, validateRequest(partsUsedSchema), vendorPartsUsed);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/customer-contact:
 *   get:
 *     summary: Customer name and phone for an accepted v2 booking
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 */
router.get('/bookings/:id/customer-contact', protect, vendorOnly, requireApprovedVendor, vendorCustomerContact);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/bill-link:
 *   post:
 *     summary: Signed 15-minute link to the printable final bill
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 */
router.post('/bookings/:id/bill-link', protect, vendorOnly, requireApprovedVendor, vendorBillLink);

/**
 * @swagger
 * /service_api/vendor/bookings/{id}/earnings:
 *   get:
 *     summary: Customer paid, platform fee, payout amount and status for one booking
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 */
router.get('/bookings/:id/earnings', protect, vendorOnly, requireApprovedVendor, getBookingEarnings);

/**
 * @swagger
 * /service_api/vendor/earnings/summary:
 *   get:
 *     summary: Earnings and settlement totals across the vendor's bookings
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     tags: [Vendor, Pricing v2]
 *     security:
 *       - bearerAuth: []
 */
router.get('/earnings/summary', protect, vendorOnly, requireApprovedVendor, getEarningsSummary);

export default router;
