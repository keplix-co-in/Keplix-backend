import express from 'express';
import { getPromotions, createPromotion } from '../../controllers/vendor/promotionController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createPromotionSchema } from '../../validators/vendor/promotionValidators.js';

const router = express.Router();

router.get('/vendor/:vendorId', protect, getPromotions);
router.post('/vendor/:vendorId/create', protect, validateRequest(createPromotionSchema), createPromotion); // Adapting to likely frontend route

// Allow direct creation if vendorId is in token
router.post('/create', protect, validateRequest(createPromotionSchema), createPromotion);

export default router;
