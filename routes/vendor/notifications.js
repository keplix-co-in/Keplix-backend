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
 *     responses:
 *       200:
 *         description: List of notifications
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
router.get('/users/:user_id/notifications', protect, getVendorNotifications);

export default router;
