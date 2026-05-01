import express from 'express';
import { getInventory, createInventory, updateInventory } from '../../controllers/vendor/inventoryController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createInventorySchema, updateInventorySchema } from '../../validators/vendor/inventoryValidators.js';

const router = express.Router();

/**
 * @swagger
 * /service_api/vendor/{vendorId}/inventory:
 *   get:
 *     summary: Get inventory for a specific vendor
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
 *         description: Vendor inventory list
 */
router.get('/vendor/:vendorId/inventory', protect, getInventory);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/inventory/create:
 *   post:
 *     summary: Create new inventory item
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
 *               - item_name
 *               - stock_level
 *             properties:
 *               item_name:
 *                 type: string
 *               stock_level:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Inventory item created successfully
 */
router.post('/vendor/:vendorId/inventory/create', protect, validateRequest(createInventorySchema), createInventory);

/**
 * @swagger
 * /service_api/vendor/{vendorId}/inventory/update/{inventoryId}:
 *   put:
 *     summary: Update inventory item
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
 *         name: inventoryId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               item_name:
 *                 type: string
 *               stock_level:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Inventory item updated successfully
 */
router.put('/vendor/:vendorId/inventory/update/:inventoryId', protect, validateRequest(updateInventorySchema), updateInventory);

// Aliases
router.get('/vendor/:vendorId/inventory/', protect, getInventory);

export default router;
