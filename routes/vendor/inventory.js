import express from 'express';
import { getInventory, createInventory, updateInventory } from '../../controllers/vendor/inventoryController.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();

router.get('/vendor/:vendorId/inventory', protect, getInventory);
router.post('/vendor/:vendorId/inventory/create', protect, createInventory);
router.put('/vendor/:vendorId/inventory/update/:inventoryId', protect, updateInventory);

// Aliases
router.get('/vendor/:vendorId/inventory/', protect, getInventory);

export default router;
