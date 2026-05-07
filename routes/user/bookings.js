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

export default router;
