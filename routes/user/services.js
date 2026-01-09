import express from 'express';
import { getAllServices, getServiceById, getServiceCategories, searchVendorsByLocation } from '../../controllers/user/serviceController.js';

const router = express.Router();

router.get('/services', getAllServices);
router.get('/services/:id', getServiceById);
router.get('/categories', getServiceCategories);
router.get('/search', searchVendorsByLocation);

export default router;
