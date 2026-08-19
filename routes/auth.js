import express from 'express';
import {
  registerUser,
  authUser,
  getUserProfile,
  updateUserProfileAuth,
  refreshToken,
  logoutUser,
  forgotPassword,
  resetPassword,
  sendPasswordResetOTP,
  resetPasswordWithOTP,
  sendPhoneOTP,
  verifyPhoneOTP,
  sendEmailOTP,
  verifyEmailOTP,
  googleLogin,
  updatePushToken
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { validateRequest } from '../middleware/validationMiddleware.js';
import { strictAuthLimiter } from '../middleware/rateLimitMiddleware.js';
import { registerSchema, loginSchema, refreshTokenSchema, resetPasswordSchema, forgotPasswordSchema, resetPasswordWithOtpSchema, googleLoginSchema, requestOtpSchema, verifyOtpSchema } from '../validators/authValidators.js';
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
router.post('/register', strictAuthLimiter, validateRequest(registerSchema), registerUser);
router.post('/signup', strictAuthLimiter, validateRequest(registerSchema), registerUser); // Alias for compatibility

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
router.post('/login', strictAuthLimiter, validateRequest(loginSchema), authUser);

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
router.post('/token/refresh', validateRequest(refreshTokenSchema), refreshToken);

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
router.post('/forgot-password', strictAuthLimiter, validateRequest(forgotPasswordSchema), forgotPassword);

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
router.post('/send-password-reset-otp', strictAuthLimiter, validateRequest(forgotPasswordSchema), sendPasswordResetOTP);

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
router.post('/reset-password-otp', strictAuthLimiter, validateRequest(resetPasswordWithOtpSchema), resetPasswordWithOTP);

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
router.post('/reset-password/:uid/:token', strictAuthLimiter, validateRequest(resetPasswordSchema), resetPassword);

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
router.post('/google', strictAuthLimiter, validateRequest(googleLoginSchema), googleLogin);

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
router.post('/send-phone-otp', strictAuthLimiter, validateRequest(requestOtpSchema), sendPhoneOTP);

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
// Deliberately on the mount-wide authLimiter (20/15min) rather than
// strictAuthLimiter (3/2h): a legitimate user mistyping an OTP twice must not
// be locked out for two hours. 20 tries per 15 min against a 6-digit code that
// expires in minutes is ample — an attacker gets ~13 guesses out of 1,000,000
// per OTP window.
router.post('/verify-phone-otp', validateRequest(verifyOtpSchema), verifyPhoneOTP);

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
router.post('/send-email-otp', strictAuthLimiter, validateRequest(requestOtpSchema), sendEmailOTP);

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
// See verify-phone-otp for why this is not strictAuthLimiter.
router.post('/verify-email-otp', validateRequest(verifyOtpSchema), verifyEmailOTP);

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
router.get('/profile', protect, getUserProfile);
router.put('/profile', protect, uploadProfileFields, updateUserProfileAuth);

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
router.put('/push-token', protect, updatePushToken);

// Compatibility aliases (for trailing slashes if needed by legacy frontend code)
router.post('/signup/', strictAuthLimiter, validateRequest(registerSchema), registerUser);
router.post('/login/', strictAuthLimiter, validateRequest(loginSchema), authUser);
router.post('/token/refresh/', validateRequest(refreshTokenSchema), refreshToken);

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
logoutRouter.post('/logout', logoutUser);
logoutRouter.post('/logout/', logoutUser);
