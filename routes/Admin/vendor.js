import express from 'express';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import { getVendorMetrics, getVendors } from '../../controllers/Admin/vendorController.js';
const router = express.Router();

router.get("/vendors/metrics", authAdmin, authorizeAdmin, getVendorMetrics);

router.get("/vendors", authAdmin, authorizeAdmin, getVendors);



export default router;