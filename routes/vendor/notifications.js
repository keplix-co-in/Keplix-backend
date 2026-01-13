import express from 'express';
import { getVendorNotifications, markVendorRead } from '../../controllers/vendor/notificationController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

// Matches /interactions/api/vendor/users/:user_id/notifications ?? 
// Or better: /interactions/api/vendor/notifications
router.get('/notifications', protect, getVendorNotifications); 
router.put('/notifications/:id/mark-read', protect, markVendorRead);

// Legacy support if needed, but cleaner:
router.get('/users/:user_id/notifications', protect, getVendorNotifications);

export default router;
