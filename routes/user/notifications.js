import express from 'express';
import { getNotifications, markRead, createNotification } from '../../controllers/user/notificationController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/users/:user_id/notifications', protect, getNotifications);
router.put('/notifications/:id/mark-read', protect, markRead);
router.post('/notifications/create', protect, createNotification);

// Aliases
router.get('/users/:user_id/notifications/', protect, getNotifications); 
router.put('/notifications/:id/mark-read/', protect, markRead);

export default router;
