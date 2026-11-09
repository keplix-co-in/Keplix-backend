import express from 'express';
// 2026-11 Supabase Auth migration: sign-in, sign-up, refresh, password reset
// and Google login now happen in Supabase. The old routes below answer 426
// APP_UPDATE_REQUIRED (see controllers/supabaseAuthController.js).
import {
  getUserProfile,
  updateUserProfileAuth,
  requestEmailChange,
  verifyEmailChange,
  sendPhoneOTP,
  verifyPhoneOTP,
  updatePushToken,
  registerWebPush,
  unregisterWebPush,
  deleteAccount,
  exportAccountData
} from '../controllers/authController.js';
import { protect, requireSupabaseSession } from '../middleware/authMiddleware.js';
import { syncSupabaseUser, legacyAuthRetired, legacyLogout } from '../controllers/supabaseAuthController.js';
// Mounted AFTER protect on the routes below, so the limiter keys on the user id
// rather than the shared carrier NAT address. See app.js for the full reasoning.
// Security O-001: otpVerifyLimiter adds a per-email/phone budget on every OTP verify route.
import { authedReadLimiter, authLimiter, otpVerifyLimiter, stepUpOtpLimiter } from '../middleware/rateLimitMiddleware.js';
import { validateRequest } from '../middleware/validationMiddleware.js';
import { requestOtpSchema, verifyOtpSchema } from '../validators/authValidators.js';
import {uploadFieldss} from '../middleware/uploadMiddleware.js';

const router = express.Router();

// Upload middleware for profile images and ID proofs
const uploadProfileFields = uploadFieldss([
  { name: 'profile_picture', maxCount: 1 },
  { name: 'id_proof_front', maxCount: 1 },
  { name: 'id_proof_back', maxCount: 1 }
]);

// Auth Routes (Standard)
/**
 * @swagger
 * /accounts/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 *                 description: Standard user ('user') or vendor ('vendor')
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Bad request
 */
// Same strict limit as /signup — this alias was an unlimited signup route.
router.post('/register', legacyAuthRetired);
router.post('/signup', legacyAuthRetired);

/**
 * @swagger
 * /accounts/auth/login:
 *   post:
 *     summary: User login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 example: user@gmail.com
 *               password:
 *                 type: string
 *                 example: 123456
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', legacyAuthRetired);

/**
 * @swagger
 * /accounts/auth/token/refresh:
 *   post:
 *     summary: Refresh access token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token refreshed
 */
router.post('/token/refresh', legacyAuthRetired);

/**
 * @swagger
 * /accounts/auth/forgot-password:
 *   post:
 *     summary: Request password reset
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Reset email sent
 */
router.post('/forgot-password', legacyAuthRetired);

/**
 * @swagger
 * /accounts/auth/send-password-reset-otp:
 *   post:
 *     summary: Send a 6-digit OTP by email for password reset
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: OTP sent (if the email exists)
 */
router.post('/send-password-reset-otp', legacyAuthRetired);

/**
 * @swagger
 * /accounts/auth/reset-password-otp:
 *   post:
 *     summary: Verify OTP and set a new password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               otp:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password reset successfully
 */
router.post('/reset-password-otp', legacyAuthRetired);

/**
 * @swagger
 * /accounts/auth/reset-password/{uid}/{token}:
 *   post:
 *     summary: Reset password
 *     tags: [Auth]
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password reset successful
 */
router.post('/reset-password/:uid/:token', legacyAuthRetired);

/**
 * @swagger
 * /accounts/auth/google:
 *   post:
 *     summary: Google login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               idToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 */
// Rate limited like every other credential-accepting route.
router.post('/google', legacyAuthRetired);

// First call after ANY Supabase sign-in (email or Google): links the Supabase
// user to the existing Keplix account, or creates the account + profile.
router.post('/supabase/sync', authLimiter, requireSupabaseSession, syncSupabaseUser);

// OTP Routes
/**
 * @swagger
 * /accounts/auth/send-phone-otp:
 *   post:
 *     summary: Send OTP to phone
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               phone:
 *                 type: string
 *     responses:
 *       200:
 *         description: OTP sent
 */
router.post('/send-phone-otp', authLimiter, validateRequest(requestOtpSchema), sendPhoneOTP);

/**
 * @swagger
 * /accounts/auth/verify-phone-otp:
 *   post:
 *     summary: Verify phone OTP
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               phone:
 *                 type: string
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: OTP verified
 */
// Covered by the mount-wide authLimiter (20/15min). 20 tries per 15 min
// against a 6-digit code that expires in minutes is ample — an attacker gets
// ~13 guesses out of 1,000,000 per OTP window.
//
// The old per-route strictAuthLimiter (3 requests / 2 hours) has been removed
// from this file entirely. It was keyed on req.ip while `trust proxy` was
// unset, so behind Cloud Run every request resolved to the same proxy address
// and the three attempts were shared by EVERY user of both apps — locking the
// whole platform out of login for two hours at a time.
router.post('/verify-phone-otp', authLimiter, otpVerifyLimiter, validateRequest(verifyOtpSchema), verifyPhoneOTP);

/**
 * @swagger
 * /accounts/auth/send-email-otp:
 *   post:
 *     summary: Send OTP to email
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: OTP sent
 */
router.post('/send-email-otp', legacyAuthRetired);

/**
 * @swagger
 * /accounts/auth/verify-email-otp:
 *   post:
 *     summary: Verify email OTP
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: OTP verified
 */
// See verify-phone-otp for the limiter reasoning.
router.post('/verify-email-otp', legacyAuthRetired);

// Protected Routes
/**
 * @swagger
 * /accounts/auth/profile:
 *   get:
 *     summary: Get current user profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile data retrieved
 *   put:
 *     summary: Update user profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               profile_picture:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Profile updated
 */
// authedReadLimiter, not the surrounding authLimiter: these are ordinary
// authenticated endpoints that both apps call on every screen focus. Sharing the
// 40-per-15-min credential budget meant ~20 profile views locked every user on
// that IP out of logging in.
router.get('/profile', protect, authedReadLimiter, getUserProfile);
router.put('/profile', protect, authedReadLimiter, uploadProfileFields, updateUserProfileAuth);
// Security A-005: two-step email change (OTP to the new address). PUT /profile
// no longer writes the email.
router.post('/email-change/request', protect, stepUpOtpLimiter, requestEmailChange);
router.post('/email-change/verify', protect, otpVerifyLimiter, verifyEmailChange);

/**
 * @swagger
 * /accounts/auth/push-token:
 *   put:
 *     summary: Update push notification token
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pushToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Push token updated
 */
// Re-sent on every app launch -- same reasoning as /profile above.
router.put('/push-token', protect, authedReadLimiter, updatePushToken);

/**
 * @swagger
 * /accounts/auth/web-push:
 *   post:
 *     summary: Save this browser's Web Push subscription (vendor portal alerts)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [endpoint, keys]
 *             properties:
 *               endpoint:
 *                 type: string
 *               keys:
 *                 type: object
 *                 properties:
 *                   p256dh:
 *                     type: string
 *                   auth:
 *                     type: string
 *     responses:
 *       200:
 *         description: Subscription saved
 *       400:
 *         description: Unsupported endpoint or invalid keys
 *   delete:
 *     summary: Remove this browser's Web Push subscription
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [endpoint]
 *             properties:
 *               endpoint:
 *                 type: string
 *     responses:
 *       200:
 *         description: Subscription removed
 */
router.post('/web-push', protect, authedReadLimiter, registerWebPush);
router.delete('/web-push', protect, authedReadLimiter, unregisterWebPush);

/**
 * @swagger
 * /accounts/auth/password/change:
 *   put:
 *     summary: Change the current user's password (verifies the current password server-side)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               oldPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password changed successfully
 *       401:
 *         description: Current password is incorrect
 */
// Password changes happen in Supabase (supabase.auth.updateUser) now.
router.put('/password/change', legacyAuthRetired);

/**
 * @swagger
 * /accounts/auth/account:
 *   delete:
 *     summary: Erase the caller's own account (GDPR Art.17) — deactivates and redacts personal data
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Account deactivated and personal data erased
 */
router.delete('/account', protect, authedReadLimiter, deleteAccount);

/**
 * @swagger
 * /accounts/auth/export:
 *   get:
 *     summary: Export all of the caller's own data (GDPR Art.15/Art.20 access and portability)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: JSON bundle of the caller's account, bookings, payments, reviews, messages, notifications, feedback, vehicles and walk-in history
 */
router.get('/export', protect, authedReadLimiter, exportAccountData);

// Compatibility aliases (for trailing slashes if needed by legacy frontend code)
router.post('/signup/', legacyAuthRetired);
router.post('/login/', legacyAuthRetired);
router.post('/token/refresh/', legacyAuthRetired);

export default router;

// Logout routes - exported separately to be mounted without rate limiting
export const logoutRouter = express.Router();
/**
 * @swagger
 * /accounts/auth/logout:
 *   post:
 *     summary: Logout user
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Logout successful
 */
logoutRouter.post('/logout', legacyLogout);
logoutRouter.post('/logout/', legacyLogout);
