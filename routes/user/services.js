import express from 'express';
import { getAllServices, getServiceById, getServiceCategories, searchVendorsByLocation, getServicesByVendor, getFeaturedServices } from '../../controllers/user/serviceController.js';

const router = express.Router();

router.get('/services', getAllServices);
router.get('/services/featured', getFeaturedServices);
router.get('/services/:id', getServiceById);
router.get('/categories', getServiceCategories);
router.get('/search', searchVendorsByLocation);
router.get('/vendors/:vendorId/services', getServicesByVendor);

export default router;
