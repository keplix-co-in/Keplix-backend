import express from 'express';
import { getVendorServices, createService, updateService, deleteService } from '../../controllers/vendor/serviceController.js';
import { protect } from '../../middleware/authMiddleware.js';
import upload from '../../middleware/uploadMiddleware.js';

const router = express.Router();

router.get('/services', protect, getVendorServices);
router.post('/services', protect, upload.single('image'), createService);
router.put('/services/:id', protect, updateService);
router.delete('/services/:id', protect, deleteService);

export default router;
