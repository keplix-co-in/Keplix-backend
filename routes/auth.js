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
  sendPhoneOTP, 
  verifyPhoneOTP, 
  sendEmailOTP, 
  verifyEmailOTP, 
  googleLogin,
  updatePushToken
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { validateRequest } from '../middleware/validationMiddleware.js';
import { registerSchema, loginSchema, refreshTokenSchema, resetPasswordSchema, forgotPasswordSchema, googleLoginSchema, requestOtpSchema, verifyOtpSchema } from '../validators/authValidators.js';
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
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               phone:
 *                 type: string
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Bad request
 */
router.post('/register', validateRequest(registerSchema), registerUser);
router.post('/signup', validateRequest(registerSchema), registerUser); // Alias for compatibility

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
router.post('/login', validateRequest(loginSchema), authUser);

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
router.post('/forgot-password', validateRequest(forgotPasswordSchema), forgotPassword);

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
router.post('/reset-password/:uid/:token', validateRequest(resetPasswordSchema), resetPassword);

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
router.post('/google', validateRequest(googleLoginSchema), googleLogin);

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
router.post('/send-phone-otp', validateRequest(requestOtpSchema), sendPhoneOTP);

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
router.post('/send-email-otp', validateRequest(requestOtpSchema), sendEmailOTP);

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
router.post('/signup/', validateRequest(registerSchema), registerUser);
router.post('/login/', validateRequest(loginSchema), authUser);
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
