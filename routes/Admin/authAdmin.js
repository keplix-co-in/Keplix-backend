import express from 'express';
<<<<<<< HEAD
import { login }from '../../controllers/Admin/authController.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { loginSchema } from '../../validators/Admin/authAdminValidator.js';
const router = express.Router();


router.post("/login", validateRequest(loginSchema), login);


export default router;
=======
import { login, refresh, logout } from '../../controllers/Admin/authController.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { loginSchema, refreshTokenSchema } from '../../validators/Admin/authAdminValidator.js';

const router = express.Router();

/**
 * @swagger
 * /admin/auth/login:
 *   post:
 *     summary: Admin login
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Returns accessToken (15 min) and refreshToken (7 days)
 */
router.post('/login', validateRequest(loginSchema), login);

/**
 * @swagger
 * /admin/auth/refresh:
 *   post:
 *     summary: Rotate refresh token and issue a new access token
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Returns new accessToken and rotated refreshToken
 *       401:
 *         description: Invalid or expired refresh token
 */
router.post('/refresh', validateRequest(refreshTokenSchema), refresh);

/**
 * @swagger
 * /admin/auth/logout:
 *   post:
 *     summary: Invalidate the admin session by clearing the stored refresh token
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       401:
 *         description: Invalid refresh token
 */
router.post('/logout', validateRequest(refreshTokenSchema), logout);

export default router;
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
