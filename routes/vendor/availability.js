import express from 'express';
import { getAvailability, createAvailability } from '../../controllers/vendor/availabilityController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { manageAvailabilitySchema } from '../../validators/vendor/availabilityValidators.js';

const router = express.Router();

/**
 * @swagger
 * /service_api/vendor/{vendorId}/availability:
 *   get:
 *     summary: Get availability for a specific vendor
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
 *         description: Vendor availability list
 */
router.get('/vendor/:vendorId/availability', protect, getAvailability);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/availability/create:
 *   post:
 *     summary: Create or update availability for a vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
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
 *               - day_of_week
 *               - start_time
 *               - end_time
 *             properties:
 *               day_of_week:
 *                 type: string
 *                 example: Monday
 *               start_time:
 *                 type: string
 *                 example: "09:00"
 *               end_time:
 *                 type: string
 *                 example: "17:00"
 *               is_available:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Availability created/updated successfully
 */
router.post('/vendor/:vendorId/availability/create', protect, validateRequest(manageAvailabilitySchema), createAvailability);

// Aliases
router.get('/vendor/:vendorId/availability/', protect, getAvailability);

export default router;
