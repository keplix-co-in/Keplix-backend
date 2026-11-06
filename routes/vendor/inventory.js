import express from 'express';
import { getInventory, createInventory, updateInventory } from '../../controllers/vendor/inventoryController.js';
// Security A-020 / SYS-003: every route here is vendor-only (per route, not
// router.use, because several vendor routers share the /service_api prefix
// with user routers). requireApprovedVendor gates money/job actions only.
import { vendorOnly } from '../../middleware/roleMiddleware.js';
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
router.get('/vendor/:vendorId/inventory', protect, vendorOnly, getInventory);

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
router.post('/vendor/:vendorId/inventory/create', protect, vendorOnly, validateRequest(createInventorySchema), createInventory);

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
router.put('/vendor/:vendorId/inventory/update/:inventoryId', protect, vendorOnly, validateRequest(updateInventorySchema), updateInventory);

// Aliases
router.get('/vendor/:vendorId/inventory/', protect, vendorOnly, getInventory);

export default router;
