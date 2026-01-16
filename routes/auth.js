import express from 'express';
import { registerUser, authUser, getUserProfile, refreshToken, logoutUser, forgotPassword, resetPassword, sendPhoneOTP, verifyPhoneOTP, sendEmailOTP, verifyEmailOTP, googleLogin } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { validateRequest } from '../middleware/validationMiddleware.js';
import { registerSchema, loginSchema, refreshTokenSchema, resetPasswordSchema, forgotPasswordSchema } from '../validators/authValidators.js';

const router = express.Router();

// Auth Routes (Standard)
router.post('/signup', validateRequest(registerSchema), registerUser);
router.post('/login', validateRequest(loginSchema), authUser);
router.post('/token/refresh', validateRequest(refreshTokenSchema), refreshToken);
router.post('/logout', logoutUser);
router.post('/forgot-password', validateRequest(forgotPasswordSchema), forgotPassword);
router.post('/reset-password/:uid/:token', validateRequest(resetPasswordSchema), resetPassword);
router.post('/google', googleLogin);

// OTP Routes
router.post('/send-phone-otp', sendPhoneOTP);
router.post('/verify-phone-otp', verifyPhoneOTP);
router.post('/send-email-otp', sendEmailOTP);
router.post('/verify-email-otp', verifyEmailOTP);

// Protected Routes
router.get('/profile', protect, getUserProfile);

// Compatibility aliases (for trailing slashes if needed by legacy frontend code)
router.post('/signup/', validateRequest(registerSchema), registerUser);
router.post('/login/', validateRequest(loginSchema), authUser);
router.post('/token/refresh/', validateRequest(refreshTokenSchema), refreshToken);
router.post('/logout/', logoutUser);

export default router;
