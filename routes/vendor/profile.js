import express from 'express';
import { getVendorProfile, updateVendorProfile, createVendorProfile } from '../../controllers/vendor/profileController.js';
import { protect } from '../../middleware/authMiddleware.js';
import upload from '../../middleware/uploadMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createVendorProfileSchema, updateVendorProfileSchema } from '../../validators/vendor/profileValidators.js';

const router = express.Router();

router.get('/', protect, getVendorProfile);
// Add upload middleware to handle FormData (image + text fields)
const uploadFields = upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'cover_image', maxCount: 1 }
]);

router.put('/', protect, uploadFields, validateRequest(updateVendorProfileSchema), updateVendorProfile);
router.patch('/', protect, uploadFields, validateRequest(updateVendorProfileSchema), updateVendorProfile);
router.post('/', protect, uploadFields, validateRequest(createVendorProfileSchema), createVendorProfile);

// Trailing slash support
router.get('/profile/', protect, getVendorProfile);
router.put('/profile/', protect, uploadFields, validateRequest(updateVendorProfileSchema), updateVendorProfile);
router.patch('/profile/', protect, uploadFields, validateRequest(updateVendorProfileSchema), updateVendorProfile);
router.post('/profile/', protect, uploadFields, validateRequest(createVendorProfileSchema), createVendorProfile);


export default router;
