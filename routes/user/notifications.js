import express from 'express';
import { getNotifications, markRead, markAllRead, deleteNotification, createNotification, updateFcmToken } from '../../controllers/user/notificationController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createNotificationSchema } from '../../validators/user/notificationValidators.js';

const router = express.Router();

/**
 * @swagger
 * /interactions/api/user/notifications/users/fcm-token:
 *   put:
 *     summary: Update FCM token for push notifications
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fcmToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: FCM token updated successfully
 */
router.put('/users/fcm-token', protect, updateFcmToken);

/**
 * @swagger
 * /interactions/api/user/notifications/users/{user_id}:
 *   get:
 *     summary: Get user notifications
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of notifications
 */
router.get('/users/:user_id', protect, getNotifications);

/**
 * @swagger
 * /interactions/api/user/notifications/{id}/mark-read:
 *   put:
 *     summary: Mark a notification as read
 *     tags: [User]
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
router.put('/:id/mark-read', protect, markRead);

/**
 * @swagger
 * /interactions/api/user/notifications/create:
 *   post:
 *     summary: Create a notification (Internal/Admin use)
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId:
 *                 type: string
 *               title:
 *                 type: string
 *               message:
 *                 type: string
 *               type:
 *                 type: string
 *     responses:
 *       201:
 *         description: Notification created
 */
router.post('/create', protect, validateRequest(createNotificationSchema), createNotification);

/**
 * @swagger
 * /interactions/api/user/notifications/user/{userId}/read-all:
 *   put:
 *     summary: Mark all notifications as read for a user
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: All notifications marked as read
 */
router.put('/user/:userId/read-all', protect, markAllRead);

/**
 * @swagger
 * /interactions/api/user/notifications/user/{userId}/{id}:
 *   delete:
 *     summary: Delete a notification
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Notification deleted
 */
router.delete('/user/:userId/:id', protect, deleteNotification);

// Aliases
router.get('/users/:user_id/', protect, getNotifications); 
router.put('/:id/mark-read/', protect, markRead);

export default router;
