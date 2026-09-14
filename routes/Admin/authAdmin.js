import express from 'express';
import { login, refresh, logout } from '../../controllers/Admin/authController.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { loginSchema, refreshTokenSchema } from '../../validators/Admin/authAdminValidator.js';
import { authLimiter } from '../../middleware/rateLimitMiddleware.js';

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
// authLimiter here, and only here: without it /admin/auth/login was bounded
// only by the global `limiter` (RATE_LIMIT_MAX, default 1000/15min) -- roughly
// 96,000 password guesses/day against the highest-privilege accounts. Not
// applied to /refresh or /logout below, since /refresh is called routinely
// by the SPA on every 15-minute access-token expiry and must not share a
// login rate limit.
router.post('/login', authLimiter, validateRequest(loginSchema), login);

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
