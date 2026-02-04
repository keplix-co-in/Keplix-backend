import express from 'express';
import { getUserProfileData, updateUserProfile } from '../../controllers/user/profileController.js';
import { protect } from '../../middleware/authMiddleware.js';


const router = express.Router();

// GET /service_api/user/:userId/profile
router.get('/:userId/profile', protect, getUserProfileData);

// PUT /service_api/user/:userId/profile
router.put('/:userId/profile', protect, updateUserProfile);

export default router;
