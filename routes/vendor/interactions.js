import express from 'express';
import { createVendorConversation, getVendorConversations, getVendorMessages, sendVendorMessage } from '../../controllers/vendor/interactionController.js';
// Security A-020 / SYS-003: every route here is vendor-only (per route, not
// router.use, because several vendor routers share the /service_api prefix
// with user routers). requireApprovedVendor gates money/job actions only.
import { vendorOnly } from '../../middleware/roleMiddleware.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { sendMessageSchema, createConversationSchema } from '../../validators/user/interactionValidators.js';

const router = express.Router();

/**
 * @swagger
 * /interactions/api/vendor/conversations:
 *   get:
 *     summary: Get all conversations for the vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of conversations
 */
router.get('/conversations', protect, vendorOnly, getVendorConversations);

/**
 * @swagger
 * /interactions/api/vendor/chat/create:
 *   post:
 *     summary: Create a new conversation
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *     responses:
 *       201:
 *         description: Conversation created successfully
 */
router.post('/chat/create', protect, vendorOnly, validateRequest(createConversationSchema), createVendorConversation);

/**
 * @swagger
 * /interactions/api/vendor/chat/{conversationId}:
 *   get:
 *     summary: Get messages in a conversation
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of messages
 */
router.get('/chat/:conversationId', protect, vendorOnly, getVendorMessages);

/**
 * @swagger
 * /interactions/api/vendor/chat/send:
 *   post:
 *     summary: Send a message
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - conversationId
 *               - content
 *             properties:
 *               conversationId:
 *                 type: string
 *               content:
 *                 type: string
 *     responses:
 *       201:
 *         description: Message sent successfully
 */
router.post('/chat/send', protect, vendorOnly, validateRequest(sendMessageSchema), sendVendorMessage);

// Aliases
router.get('/conversations/', protect, vendorOnly, getVendorConversations);

export default router;
