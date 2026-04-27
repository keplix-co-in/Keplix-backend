import express from 'express';
import { createConversationId, getConversationByBooking, getConversations, getMessages, sendMessage } from '../../controllers/user/interactionController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /interactions/api/user/conversations:
 *   get:
 *     summary: Get user's conversations
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of conversations
 *       500:
 *         description: Server Error
 */
router.get('/conversations', protect, getConversations);

/**
 * @swagger
 * /interactions/api/user/bookings/{bookingId}/conversation:
 *   get:
 *     summary: Get conversation for a specific booking
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: bookingId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Conversation details
 *       400:
 *         description: Booking ID is required
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Booking or conversation not found
 *       500:
 *         description: Server Error
 */
router.get('/bookings/:bookingId/conversation', protect, getConversationByBooking);

/**
 * @swagger
 * /interactions/api/user/chat/{conversationId}:
 *   get:
 *     summary: Get messages for a specific conversation
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of messages
 *       500:
 *         description: Server Error
 */
router.get('/chat/:conversationId', protect, getMessages);

/**
 * @swagger
 * /interactions/api/user/conversations/create:
 *   post:
 *     summary: Create a conversation for a booking
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bookingId
 *             properties:
 *               bookingId:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Conversation created
 *       200:
 *         description: Conversation already exists
 *       400:
 *         description: Booking ID is required
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Booking not found
 *       500:
 *         description: Server Error
 */
router.post('/conversations/create', protect, createConversationId);

/**
 * @swagger
 * /interactions/api/user/chat/conversation/create:
 *   post:
 *     summary: Alias to create a conversation for a booking
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bookingId
 *             properties:
 *               bookingId:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Conversation created
 *       500:
 *         description: Server Error
 */
router.post('/chat/conversation/create', protect, createConversationId); // Alias for backward compatibility

/**
 * @swagger
 * /interactions/api/user/chat/send:
 *   post:
 *     summary: Send a message in a conversation
 *     tags: [User]
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
 *               - message_text
 *             properties:
 *               conversationId:
 *                 type: integer
 *               message_text:
 *                 type: string
 *     responses:
 *       201:
 *         description: Message sent
 *       400:
 *         description: Missing fields
 *       500:
 *         description: Server Error
 */
router.post('/chat/send', protect, sendMessage);

// Aliases
router.get('/conversations/', protect, getConversations);

export default router;
