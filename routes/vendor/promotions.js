import express from 'express';
import { getPromotions, createPromotion, updatePromotion, deletePromotion } from '../../controllers/vendor/promotionController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createPromotionSchema } from '../../validators/vendor/promotionValidators.js';

const router = express.Router();

/**
 * @swagger
 * /interactions/vendors/{vendorId}/promotions:
 *   get:
 *     summary: Get all promotions for a vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of vendor promotions
 */
router.get('/:vendorId/promotions', protect, getPromotions);

/**
 * @swagger
 * /interactions/vendors/{vendorId}/promotions/create:
 *   post:
 *     summary: Create a new promotion
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - description
 *               - discount
 *               - start_date
 *               - end_date
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               discount:
 *                 type: number
 *               start_date:
 *                 type: string
 *                 format: date-time
 *               end_date:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Promotion created successfully
 */
router.post('/:vendorId/promotions/create', protect, validateRequest(createPromotionSchema), createPromotion);

/**
 * @swagger
 * /interactions/vendors/{vendorId}/promotions/{promoId}/update:
 *   put:
 *     summary: Update a promotion
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: promoId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               discount:
 *                 type: number
 *               start_date:
 *                 type: string
 *                 format: date-time
 *               end_date:
 *                 type: string
 *                 format: date-time
 *               active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Promotion updated successfully
 */
router.put('/:vendorId/promotions/:promoId/update', protect, updatePromotion);

/**
 * @swagger
 * /interactions/vendors/{vendorId}/promotions/{promoId}/delete:
 *   delete:
 *     summary: Delete a promotion
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: promoId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Promotion deleted successfully
 */
router.delete('/:vendorId/promotions/:promoId/delete', protect, deletePromotion);

export default router;
