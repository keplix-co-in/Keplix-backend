import express from 'express';
import { getAvailability, createAvailability } from '../../controllers/vendor/availabilityController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { manageAvailabilitySchema } from '../../validators/vendor/availabilityValidators.js';

const router = express.Router();

router.get('/vendor/:vendorId/availability', protect, getAvailability);
router.post('/vendor/:vendorId/availability/create', protect, validateRequest(manageAvailabilitySchema), createAvailability);

// Aliases
router.get('/vendor/:vendorId/availability/', protect, getAvailability);

export default router;
