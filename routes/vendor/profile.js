import express from 'express';
import { getVendorProfile, updateVendorProfile, createVendorProfile } from '../../controllers/vendor/profileController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', protect, getVendorProfile);
router.put('/', protect, updateVendorProfile);
router.post('/', protect, createVendorProfile);

// Trailing slash support
router.get('/profile/', protect, getVendorProfile);
router.put('/profile/', protect, updateVendorProfile);
router.post('/profile/', protect, createVendorProfile);


export default router;
