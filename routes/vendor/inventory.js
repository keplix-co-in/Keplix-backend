import express from 'express';
import { getInventory, createInventory, updateInventory } from '../../controllers/vendor/inventoryController.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { createInventorySchema, updateInventorySchema } from '../../validators/vendor/inventoryValidators.js';

const router = express.Router();

router.get('/vendor/:vendorId/inventory', protect, getInventory);
router.post('/vendor/:vendorId/inventory/create', protect, validateRequest(createInventorySchema), createInventory);
router.put('/vendor/:vendorId/inventory/update/:inventoryId', protect, validateRequest(updateInventorySchema), updateInventory);

// Aliases
router.get('/vendor/:vendorId/inventory/', protect, getInventory);

export default router;
