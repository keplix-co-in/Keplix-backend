import express from 'express';
import { getPromotions, createPromotion } from '../../controllers/vendor/promotionController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/vendor/:vendorId', protect, getPromotions);
router.post('/vendor/:vendorId/create', protect, createPromotion); // Adapting to likely frontend route

// Allow direct creation if vendorId is in token
router.post('/create', protect, createPromotion);

export default router;
