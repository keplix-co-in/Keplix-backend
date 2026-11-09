import express from 'express';
// 2026-11 Supabase Auth migration: admins sign in through Supabase; authAdmin
// maps the session to the Admin row. These old routes are retired.
import { legacyAuthRetired, legacyLogout, getAdminMe } from '../../controllers/supabaseAuthController.js';
import { authAdmin } from '../../middleware/authAdminMiddleware.js';

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
router.post('/login', legacyAuthRetired);

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
router.post('/refresh', legacyAuthRetired);

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
router.post('/logout', legacyLogout);

// Signed-in admin's profile (Supabase token). Used by the admin panel after
// supabase.auth.signInWithPassword to show name/email/role.
router.get('/me', authAdmin, getAdminMe);

export default router;
