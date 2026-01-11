import express from 'express';
import { getConversations, getMessages } from '../../controllers/user/interactionController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/conversations', protect, getConversations);
router.get('/messages', protect, getMessages);

// Aliases
router.get('/conversations/', protect, getConversations);
router.get('/messages/', protect, getMessages);

export default router;
