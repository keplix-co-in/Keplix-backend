import express from 'express';
import { getConversations, getMessages, sendMessage } from '../../controllers/user/interactionController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/conversations', protect, getConversations);
router.get('/chat/:conversationId', protect, getMessages);
router.post('/chat/send', protect, sendMessage);

// Aliases
router.get('/conversations/', protect, getConversations);

export default router;
