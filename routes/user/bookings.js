import express from 'express';
import { getUserBookings, getSingleBooking, createBooking, updateBooking, canProceedToPayment, getCancellationPreview, getVendorSlots, respondToEarlyStart } from '../../controllers/user/bookingController.js';
import { confirmServiceCompletion, disputeServiceCompletion } from '../../controllers/user/serviceConfirmationController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { 
  createBookingSchema, 
  updateBookingSchema, 
  confirmServiceSchema, 
  disputeServiceSchema,
  earlyStartRespondSchema
} from '../../validators/user/bookingValidators.js';

const router = express.Router();

import { getPaymentByBooking } from '../../controllers/user/bookingController.js';
import { getUserBookingPricing, userDecideExtraWork, userRequestCall, userBillLink } from '../../controllers/user/pricingController.js';
import { decisionSchema } from '../../validators/pricingV2Validators.js';

/**
 * @swagger
 * /service_api/user/{userId}/bookings:
 *   get:
 *     summary: Get bookings for a specific user
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID of the user
 *     responses:
 *       200:
 *         description: List of bookings
 *       500:
 *         description: Server Error
 */
/**
 * @swagger
 * /service_api/user/vendors/{vendorId}/slots:
 *   get:
 *     summary: Bookable 30-minute slots for a vendor on a date
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: date
 *         required: true
 *         schema:
 *           type: string
 *           example: "2026-08-25"
 *     responses:
 *       200:
 *         description: >
 *           { success, data: { date, closed, slots: [{ time, label, available }] } }.
 *           closed is true with an empty slots array when the weekday is a
 *           holiday or the vendor's hours are missing/unparseable.
 *       400:
 *         description: Missing or malformed date
 *       404:
 *         description: Vendor not found
 */
router.get('/vendors/:vendorId/slots', protect, getVendorSlots);

/**
 * @swagger
 * /service_api/user/{userId}/bookings/{id}/early-start/respond:
 *   post:
 *     summary: Accept or decline the vendor's request to start earlier
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [accept]
 *             properties:
 *               accept:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: "{ success, booking, message }. On accept the booking moves to in_progress."
 *       400:
 *         description: No pending early-start request
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Booking not found
 */
router.post('/:userId/bookings/:id/early-start/respond', protect, validateRequest(earlyStartRespondSchema), respondToEarlyStart);

// Matches GET /service_api/user/:userId/bookings
router.get('/:userId/bookings', protect, getUserBookings);

/**
 * @swagger
 * /service_api/user/{userId}/bookings/{id}:
 *   get:
 *     summary: Get details of a single booking
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Booking details
 *       404:
 *         description: Booking not found
 *       500:
 *         description: Server Error
 */
// Matches GET /service_api/user/:userId/bookings/:id (Get single booking)
router.get('/:userId/bookings/:id', protect, getSingleBooking);

/**
 * @swagger
 * /service_api/user/{userId}/bookings/{id}/can-pay:
 *   get:
 *     summary: Check if user can proceed to payment for a booking
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Payment eligibility status
 *       404:
 *         description: Booking not found
 *       403:
 *         description: Not authorized
 *       500:
 *         description: Server Error
 */
// Matches GET /service_api/user/:userId/bookings/:id/can-pay (Check if vendor accepted)
router.get('/:userId/bookings/:id/can-pay', protect, canProceedToPayment);

/**
 * @swagger
 * /service_api/user/{userId}/bookings/{id}/cancellation-preview:
 *   get:
 *     summary: What the customer would get refunded if they cancelled now
 *     description: >
 *       Read-only. Uses the same resolver as the real cancellation, so the
 *       amount shown before confirming matches what is actually refunded.
 *     responses:
 *       200:
 *         description: Refund preview
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Booking not found
 */
router.get('/:userId/bookings/:id/cancellation-preview', protect, getCancellationPreview);

/**
 * @swagger
 * /service_api/user/bookings/{bookingId}/payment:
 *   get:
 *     summary: Fetch payment details by booking ID
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: bookingId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Payment details
 *       400:
 *         description: Invalid bookingId
 *       404:
 *         description: Booking or payment not found
 *       500:
 *         description: Server Error
 */
// Matches GET /service_api/bookings/:bookingId/payment (fetch payment by bookingId)
router.get('/bookings/:bookingId/payment', protect, getPaymentByBooking);

/**
 * @swagger
 * /service_api/user/{userId}/bookings/create:
 *   post:
 *     summary: Create a new booking request
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - serviceId
 *               - booking_date
 *               - booking_time
 *             properties:
 *               serviceId:
 *                 type: integer
 *               booking_date:
 *                 type: string
 *                 format: date-time
 *               booking_time:
 *                 type: string
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Booking request created
 *       500:
 *         description: Server Error
 */
// Matches POST /service_api/user/:userId/bookings/create
router.post('/:userId/bookings/create', protect, validateRequest(createBookingSchema), createBooking);

/**
 * @swagger
 * /service_api/user/{userId}/bookings/update/{id}:
 *   put:
 *     summary: Update or cancel a booking
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               booking_date:
 *                 type: string
 *               booking_time:
 *                 type: string
 *               notes:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [pending, confirmed, scheduled, in_progress, service_completed, completed, cancelled, disputed, refunded]
 *     responses:
 *       200:
 *         description: Booking updated
 *       404:
 *         description: Booking not found
 *       403:
 *         description: Not authorized
 *       400:
 *         description: Invalid status update
 *       500:
 *         description: Server Error
 */
// Matches PUT /service_api/user/:userId/bookings/update/:id
router.put('/:userId/bookings/update/:id', protect, validateRequest(updateBookingSchema), updateBooking);

// CRITICAL ESCROW ENDPOINTS
/**
 * @swagger
 * /service_api/user/{userId}/bookings/{id}/confirm:
 *   post:
 *     summary: User confirms service completion (Triggers vendor payout)
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - confirmed
 *             properties:
 *               confirmed:
 *                 type: boolean
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *               comment:
 *                 type: string
 *     responses:
 *       200:
 *         description: Service confirmed and payout initiated
 *       400:
 *         description: Validation error or invalid status
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Booking not found
 *       500:
 *         description: Payout or Server Error
 */
// User confirms service completion → Triggers vendor payout
router.post('/:userId/bookings/:id/confirm', protect, validateRequest(confirmServiceSchema), confirmServiceCompletion);

/**
 * @swagger
 * /service_api/user/{userId}/bookings/{id}/dispute:
 *   post:
 *     summary: User disputes service completion
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 1000
 *     responses:
 *       200:
 *         description: Dispute raised successfully
 *       400:
 *         description: Validation error
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Booking not found
 *       500:
 *         description: Server Error
 */
// User disputes service → Blocks payout, requires admin review
router.post('/:userId/bookings/:id/dispute', protect, validateRequest(disputeServiceSchema), disputeServiceCompletion);

/**
 * @swagger
 * /service_api/user/bookings:
 *   get:
 *     summary: Get bookings for logged in user
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of bookings
 *       500:
 *         description: Server Error
 *   post:
 *     summary: Create a new booking
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - serviceId
 *               - booking_date
 *               - booking_time
 *             properties:
 *               serviceId:
 *                 type: integer
 *               booking_date:
 *                 type: string
 *                 format: date-time
 *               booking_time:
 *                 type: string
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Booking created
 *       500:
 *         description: Server Error
 */
// Alias: Allow standard REST path if needed by other components
router.get('/bookings', protect, getUserBookings);
router.post('/bookings', protect, validateRequest(createBookingSchema), createBooking);

// ---- Pricing v2 (docs/PRICING_V2_API.md sections 3 and 5). The customer is the
// only party that can approve or reject extra work: these routes check the
// booking's userId, and the vendor router has no decision route at all. ----

/**
 * @swagger
 * /service_api/user/bookings/{id}/pricing:
 *   get:
 *     summary: Pricing v2 state of a booking
 *     description: Quote, job progress, extra-work requests, final bill, running total and the can flags for the customer. A legacy booking returns {flow: legacy}.
 *     tags: [Bookings, Pricing v2]
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
 *         description: Not this customer's booking (FORBIDDEN)
 *       404:
 *         description: Booking or request not found
 */
router.get('/bookings/:id/pricing', protect, getUserBookingPricing);

/**
 * @swagger
 * /service_api/user/bookings/{id}/extra-work/{requestId}/decision:
 *   post:
 *     summary: Approve or reject extra-work items
 *     description: Each id must be a pending item of the request; otherwise 409 ITEM_NOT_PENDING and nothing is applied. Optional header x-app-version is recorded with the decision.
 *     tags: [Bookings, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Extra-work request ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               approve:
 *                 type: array
 *                 items:
 *                   type: integer
 *               reject:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: The updated pricing object
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this customer's booking (FORBIDDEN)
 *       404:
 *         description: Booking or request not found
 *       409:
 *         description: ITEM_NOT_PENDING, REQUEST_CLOSED, BILL_EXISTS or NOT_V2
 */
router.post('/bookings/:id/extra-work/:requestId/decision', protect, validateRequest(decisionSchema), userDecideExtraWork);

/**
 * @swagger
 * /service_api/user/bookings/{id}/extra-work/{requestId}/call-request:
 *   post:
 *     summary: Ask the garage to call about an extra-work request
 *     description: Records the request and notifies the garage. Never approves or rejects anything.
 *     tags: [Bookings, Pricing v2]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Booking ID
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Extra-work request ID
 *     responses:
 *       200:
 *         description: The updated pricing object
 *       400:
 *         description: Invalid id or body (VALIDATION_ERROR)
 *       403:
 *         description: Not this customer's booking (FORBIDDEN)
 *       404:
 *         description: Booking or request not found
 *       409:
 *         description: REQUEST_CLOSED or NOT_V2
 */
router.post('/bookings/:id/extra-work/:requestId/call-request', protect, userRequestCall);

/**
 * @swagger
 * /service_api/user/bookings/{id}/bill-link:
 *   post:
 *     summary: Signed 15-minute link to the printable final bill (Download Invoice)
 *     description: Returns {url, expires_at}. 409 BILL_NOT_ISSUED when there is no bill yet.
 *     tags: [Bookings, Pricing v2]
 *     security:
 *       - bearerAuth: []
 */
router.post('/bookings/:id/bill-link', protect, userBillLink);

export default router;
