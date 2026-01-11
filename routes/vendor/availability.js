import express from 'express';
import { getAvailability, createAvailability } from '../../controllers/vendor/availabilityController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/vendor/:vendorId/availability', protect, getAvailability);
router.post('/vendor/:vendorId/availability/create', protect, createAvailability);

// Aliases
router.get('/vendor/:vendorId/availability/', protect, getAvailability);

export default router;
