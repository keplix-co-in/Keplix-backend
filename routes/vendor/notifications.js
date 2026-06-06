import express from 'express';
import { getVendorNotifications, markVendorRead } from '../../controllers/vendor/notificationController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /interactions/api/vendor/notifications:
 *   get:
 *     summary: Get all notifications for the vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of notifications per page
 *       - in: query
 *         name: isRead
 *         schema:
 *           type: string
 *           enum: [true, false]
 *         description: Filter by read/unread status
 *     responses:
 *       200:
 *         description: List of notifications with pagination info
 */
router.get('/notifications', protect, getVendorNotifications); 

/**
 * @swagger
 * /interactions/api/vendor/notifications/{id}/mark-read:
 *   put:
 *     summary: Mark a notification as read
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Notification marked as read
 */
router.put('/notifications/:id/mark-read', protect, markVendorRead);

// Legacy support if needed, but cleaner:
/**
 * @swagger
 * /interactions/api/vendor/users/{user_id}/notifications:
 *   get:
 *     summary: Get user notifications (Vendor view)
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *       - in: query
 *         name: isRead
 *         schema:
 *           type: string
 *           enum: [true, false]
 *     responses:
 *       200:
 *         description: List of notifications
 */
router.get('/users/:user_id/notifications', protect, getVendorNotifications);

export default router;
