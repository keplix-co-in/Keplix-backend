import express from 'express';
import { getVendorServices, createService, updateService, deleteService } from '../../controllers/vendor/serviceController.js';
import { protect } from '../../middleware/authMiddleware.js';
import upload from '../../middleware/uploadMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createServiceSchema, updateServiceSchema } from '../../validators/vendor/serviceValidators.js';

const router = express.Router();

router.get('/services', protect, getVendorServices);
router.post('/services', protect, upload.single('image'), validateRequest(createServiceSchema), createService);
router.put('/services/:id', protect, validateRequest(updateServiceSchema), updateService); // Update might also need image upload?
router.delete('/services/:id', protect, deleteService);

export default router;
