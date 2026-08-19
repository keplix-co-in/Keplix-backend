import express from 'express';
import { createVendorConversation, getVendorConversations, getVendorMessages, sendVendorMessage } from '../../controllers/vendor/interactionController.js';
import { protect } from '../../middleware/authMiddleware.js';

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
router.get('/conversations', protect, getVendorConversations);

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
router.post('/chat/create', protect, createVendorConversation);

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
router.get('/chat/:conversationId', protect, getVendorMessages);

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
router.post('/chat/send', protect, sendVendorMessage);

// Aliases
router.get('/conversations/', protect, getVendorConversations);

export default router;
