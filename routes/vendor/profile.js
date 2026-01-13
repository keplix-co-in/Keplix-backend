import express from 'express';
import { getVendorProfile, updateVendorProfile, createVendorProfile } from '../../controllers/vendor/profileController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createVendorProfileSchema, updateVendorProfileSchema } from '../../validators/vendor/profileValidators.js';

const router = express.Router();

router.get('/', protect, getVendorProfile);
router.put('/', protect, validateRequest(updateVendorProfileSchema), updateVendorProfile);
router.post('/', protect, validateRequest(createVendorProfileSchema), createVendorProfile);

// Trailing slash support
router.get('/profile/', protect, getVendorProfile);
router.put('/profile/', protect, validateRequest(updateVendorProfileSchema), updateVendorProfile);
router.post('/profile/', protect, validateRequest(createVendorProfileSchema), createVendorProfile);


export default router;
