import express from 'express';
import { getVendorProfile, updateVendorProfile, createVendorProfile } from '../../controllers/vendor/profileController.js';
import { protect } from '../../middleware/authMiddleware.js';
import upload from '../../middleware/uploadMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createVendorProfileSchema, updateVendorProfileSchema } from '../../validators/vendor/profileValidators.js';

const router = express.Router();

router.get('/', protect, getVendorProfile);
// Add upload middleware to handle FormData (image + text fields)
router.patch('/', protect, upload.single('image'), validateRequest(updateVendorProfileSchema), updateVendorProfile);
router.post('/', protect, upload.single('image'), validateRequest(createVendorProfileSchema), createVendorProfile);




export default router;
