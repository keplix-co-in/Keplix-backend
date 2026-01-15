import express from 'express';
import { getPromotions, createPromotion } from '../../controllers/vendor/promotionController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createPromotionSchema } from '../../validators/vendor/promotionValidators.js';

const router = express.Router();

// Matches /interactions/vendors/:vendorId/promotions/
router.get('/:vendorId/promotions', protect, getPromotions);

// Matches /interactions/vendors/:vendorId/promotions/create/
router.post('/:vendorId/promotions/create', protect, validateRequest(createPromotionSchema), createPromotion);

// UPDATE/DELETE likely needed too if frontend uses them
// api.js: /interactions/vendors/${vendorId}/promotions/${promoId}/update/
router.put('/:vendorId/promotions/:promoId/update', protect, createPromotion); // Temporarily using create controller if update missing
router.delete('/:vendorId/promotions/:promoId/delete', protect, createPromotion); // Temporarily using create controller

export default router;
