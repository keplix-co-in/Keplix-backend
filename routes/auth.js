import express from 'express';
import { registerUser, authUser, getUserProfile, refreshToken, logoutUser, forgotPassword, resetPassword, sendPhoneOTP, verifyPhoneOTP, googleLogin } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/signup', registerUser);
router.post('/login', authUser); // Maps to /accounts/auth/login/
router.post('/login/', authUser); // Maps to /accounts/auth/login/
router.get('/profile', protect, getUserProfile); // Maps to /accounts/auth/profile/
router.post('/token/refresh', refreshToken);
router.post('/logout', logoutUser);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:uid/:token', resetPassword);
router.post('/send-phone-otp', sendPhoneOTP);
router.post('/verify-phone-otp', verifyPhoneOTP);
router.post('/google', googleLogin);
router.post('/google/', googleLogin);

// Compatibility aliases (if frontend uses trailing slashes)
router.post('/signup/', registerUser);
router.post('/login/', authUser);
router.get('/profile/', protect, getUserProfile);
router.post('/token/refresh/', refreshToken);
router.post('/logout/', logoutUser);
router.post('/forgot-password/', forgotPassword);
router.post('/send-phone-otp/', sendPhoneOTP);
router.post('/verify-phone-otp/', verifyPhoneOTP);

export default router;
