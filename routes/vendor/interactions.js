import express from 'express';
import { getVendorConversations, getVendorMessages, sendVendorMessage } from '../../controllers/vendor/interactionController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/conversations', protect, getVendorConversations);
router.get('/messages', protect, getVendorMessages); // Keep for backward compatibility if needed
router.get('/chat/:conversationId', protect, getVendorMessages);
router.post('/chat/send', protect, sendVendorMessage);

// Aliases
router.get('/conversations/', protect, getVendorConversations);

export default router;
