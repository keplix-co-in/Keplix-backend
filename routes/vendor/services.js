import express from 'express';
import { getVendorServices, createService, updateService, deleteService } from '../../controllers/vendor/serviceController.js';
import { protect } from '../../middleware/authMiddleware.js';
import upload from '../../middleware/uploadMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createServiceSchema, updateServiceSchema } from '../../validators/vendor/serviceValidators.js';

const router = express.Router();

// Matches GET /service_api/vendor/:vendorId/services
router.get('/:vendorId/services', protect, getVendorServices);

// Matches POST /service_api/vendor/:vendorId/services/create
router.post('/:vendorId/services/create', protect, validateRequest(createServiceSchema), createService);

// Matches PUT /service_api/vendor/:vendorId/services/update/:id
router.put('/:vendorId/services/update/:id', protect, validateRequest(updateServiceSchema), updateService);

// Matches DELETE /service_api/vendor/:vendorId/services/delete/:id
router.delete('/:vendorId/services/delete/:id', protect, deleteService);

export default router;
