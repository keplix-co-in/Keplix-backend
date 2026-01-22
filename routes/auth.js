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
  googleLogin 
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { validateRequest } from '../middleware/validationMiddleware.js';
import { registerSchema, loginSchema, refreshTokenSchema, resetPasswordSchema, forgotPasswordSchema, googleLoginSchema, requestOtpSchema, verifyOtpSchema } from '../validators/authValidators.js';
import upload from '../middleware/uploadMiddleware.js';

const router = express.Router();

// Upload middleware for profile images and ID proofs
const uploadProfileFields = upload.fields([
  { name: 'profile_picture', maxCount: 1 },
  { name: 'id_proof_front', maxCount: 1 },
  { name: 'id_proof_back', maxCount: 1 }
]);

// Auth Routes (Standard)
router.post('/register', validateRequest(registerSchema), registerUser);
router.post('/signup', validateRequest(registerSchema), registerUser); // Alias for compatibility
router.post('/login', validateRequest(loginSchema), authUser);
router.post('/token/refresh', validateRequest(refreshTokenSchema), refreshToken);
router.post('/forgot-password', validateRequest(forgotPasswordSchema), forgotPassword);
router.post('/reset-password/:uid/:token', validateRequest(resetPasswordSchema), resetPassword);
router.post('/google', validateRequest(googleLoginSchema), googleLogin);

// OTP Routes
router.post('/send-phone-otp', validateRequest(requestOtpSchema), sendPhoneOTP);
router.post('/verify-phone-otp', validateRequest(verifyOtpSchema), verifyPhoneOTP);
router.post('/send-email-otp', validateRequest(requestOtpSchema), sendEmailOTP);
router.post('/verify-email-otp', validateRequest(verifyOtpSchema), verifyEmailOTP);

// Protected Routes
router.get('/profile', protect, getUserProfile);
router.put('/profile', protect, uploadProfileFields, updateUserProfileAuth);

// Compatibility aliases (for trailing slashes if needed by legacy frontend code)
router.post('/signup/', validateRequest(registerSchema), registerUser);
router.post('/login/', validateRequest(loginSchema), authUser);
router.post('/token/refresh/', validateRequest(refreshTokenSchema), refreshToken);

export default router;

// Logout routes - exported separately to be mounted without rate limiting
export const logoutRouter = express.Router();
logoutRouter.post('/logout', logoutUser);
logoutRouter.post('/logout/', logoutUser);
