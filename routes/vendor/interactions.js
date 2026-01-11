import express from 'express';
import { getVendorConversations, getVendorMessages } from '../../controllers/vendor/interactionController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/conversations', protect, getVendorConversations);
router.get('/messages', protect, getVendorMessages);

// Aliases
router.get('/conversations/', protect, getVendorConversations);
router.get('/messages/', protect, getVendorMessages);

export default router;
