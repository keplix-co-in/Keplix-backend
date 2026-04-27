import express from 'express';
import { getUserProfileData, updateUserProfile } from '../../controllers/user/profileController.js';
import { protect } from '../../middleware/authMiddleware.js';
import upload from '../../middleware/uploadMiddleware.js';

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
router.put('/:userId/profile', protect, upload.single('profile_picture'), updateUserProfile);

export default router;
