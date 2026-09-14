import express from 'express';
import { getUserProfileData, updateUserProfile, deleteUserAccount, exportUserData } from '../../controllers/user/profileController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { authedReadLimiter } from '../../middleware/rateLimitMiddleware.js';
import {uploadSingle} from '../../middleware/uploadMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /service_api/user/{userId}/profile:
 *   get:
 *     summary: Get user profile data
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User profile data retrieved successfully
 */
router.get('/:userId/profile', protect, getUserProfileData);

/**
 * @swagger
 * /service_api/user/{userId}/profile:
 *   put:
 *     summary: Update user profile
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               phone:
 *                 type: string
 *               address:
 *                 type: string
 *               profile_picture:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: User profile updated successfully
 */
router.put('/:userId/profile', protect, uploadSingle('profile_picture'), updateUserProfile);

/**
 * @swagger
 * /service_api/user/{userId}/account:
 *   delete:
 *     summary: Erase the caller's own account (GDPR Art.17) — deactivates and redacts personal data
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Account deactivated and personal data erased
 *       403:
 *         description: Not authorized (caller does not own this account)
 *       404:
 *         description: User not found
 */
router.delete('/:userId/account', protect, authedReadLimiter, deleteUserAccount);

/**
 * @swagger
 * /service_api/user/{userId}/export:
 *   get:
 *     summary: Export all of the caller's own data (GDPR Art.15/Art.20 access and portability)
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: JSON bundle of the caller's account, bookings, payments, reviews, messages, notifications, feedback, vehicles and walk-in history
 *       403:
 *         description: Not authorized (caller does not own this account)
 *       404:
 *         description: User not found
 */
router.get('/:userId/export', protect, authedReadLimiter, exportUserData);

export default router;
