import express from 'express';
import { getNotifications, markRead, markAllRead, deleteNotification, createNotification, updateFcmToken } from '../../controllers/user/notificationController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createNotificationSchema } from '../../validators/user/notificationValidators.js';

const router = express.Router();

router.put('/users/fcm-token', protect, updateFcmToken); // New Route
router.get('/users/:user_id/notifications', protect, getNotifications);
router.put('/notifications/:id/mark-read', protect, markRead);
router.post('/notifications/create', protect, validateRequest(createNotificationSchema), createNotification);

// New escrow-compatible routes
router.put('/user/:userId/notifications/read-all', protect, markAllRead);
router.delete('/user/:userId/notifications/:id', protect, deleteNotification);

// Aliases
router.get('/users/:user_id/notifications/', protect, getNotifications); 
router.put('/notifications/:id/mark-read/', protect, markRead);

export default router;
