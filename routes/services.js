import express from 'express';
import { getVendorServices, createService, updateService, deleteService, getAllServices, getServiceById, getServiceCategories, searchVendorsByLocation } from '../controllers/serviceController.js';
import { protect } from '../middleware/authMiddleware.js';
import upload from '../middleware/uploadMiddleware.js';

const router = express.Router();

// Vendor Routes
router.get('/vendor/services', protect, getVendorServices);
router.post('/vendor/services', protect, upload.single('image'), createService);

// Public Routes
router.get('/user/services', getAllServices);
router.get('/user/services/:id', getServiceById);
router.get('/services/categories', getServiceCategories);
router.get('/search/vendors/location', searchVendorsByLocation);

// Aliases
router.get('/services/categories/', getServiceCategories);
router.get('/search/vendors/location/', searchVendorsByLocation);

// Compatibility aliases (Trailing slashes)
router.get('/vendor/services/', protect, getVendorServices);
router.post('/vendor/services/', protect, upload.single('image'), createService);
router.get('/user/services/', getAllServices);
router.get('/services/:id/', getServiceById);

export default router;
