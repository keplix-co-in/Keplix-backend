import express from 'express';
import { registerUser, authUser, getUserProfile, refreshToken, logoutUser, forgotPassword, resetPassword, sendPhoneOTP, verifyPhoneOTP, sendEmailOTP, verifyEmailOTP, googleLogin } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { validateRequest } from '../middleware/validationMiddleware.js';
import { registerSchema, loginSchema, refreshTokenSchema, resetPasswordSchema, forgotPasswordSchema } from '../validators/authValidators.js';

const router = express.Router();

router.post('/signup', validateRequest(registerSchema), registerUser);
router.post('/signup', registerUser);
router.post('/login', authUser); // Maps to /accounts/auth/login/
router.post('/login/', authUser); // Maps to /accounts/auth/login/
router.get('/profile', protect, getUserProfile); // Maps to /accounts/auth/profile/
router.post('/token/refresh', refreshToken);

router.post('/signup', validateRequest(registerSchema), registerUser);
router.post('/login', validateRequest(loginSchema), authUser);
router.get('/profile', protect, getUserProfile);
router.post('/token/refresh', validateRequest(refreshTokenSchema), refreshToken);

router.post('/logout', logoutUser);
router.post('/forgot-password', validateRequest(forgotPasswordSchema), forgotPassword);
router.post('/reset-password/:uid/:token', validateRequest(resetPasswordSchema), resetPassword);
router.post('/send-phone-otp', sendPhoneOTP);
router.post('/verify-phone-otp', verifyPhoneOTP);
router.post('/send-email-otp', sendEmailOTP);
router.post('/verify-email-otp', verifyEmailOTP);
router.post('/google', googleLogin);

// Compatibility aliases (if frontend uses trailing slashes)
router.post('/signup/', validateRequest(registerSchema), registerUser);
router.post('/login/', validateRequest(loginSchema), authUser);
router.get('/profile/', protect, getUserProfile);
router.post('/token/refresh/', validateRequest(refreshTokenSchema), refreshToken);
router.post('/logout/', logoutUser);
router.post('/forgot-password/', validateRequest(forgotPasswordSchema), forgotPassword);
router.post('/send-phone-otp/', sendPhoneOTP);
router.post('/verify-phone-otp/', verifyPhoneOTP);
router.post('/send-email-otp/', sendEmailOTP);
router.post('/verify-email-otp/', verifyEmailOTP);

export default router;
