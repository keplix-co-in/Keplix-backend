import express from 'express';
import { createConversationId, getConversationByBooking, getConversations, getMessages, sendMessage } from '../../controllers/user/interactionController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/conversations', protect, getConversations);
router.get('/bookings/:bookingId/conversation', protect, getConversationByBooking);
router.get('/chat/:conversationId', protect, getMessages);
router.post('/conversations/create', protect, createConversationId);
router.post('/chat/conversation/create', protect, createConversationId); // Alias for backward compatibility
router.post('/chat/send', protect, sendMessage);

// Aliases
router.get('/conversations/', protect, getConversations);

export default router;
