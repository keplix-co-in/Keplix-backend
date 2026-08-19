import express from 'express';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import { getVendorMetrics, getVendors } from '../../controllers/Admin/vendorController.js';
const router = express.Router();

<<<<<<< HEAD
router.get("/vendors/metrics", authAdmin, authorizeAdmin, getVendorMetrics);

=======
/**
 * @swagger
 * /admin/vendors/metrics:
 *   get:
 *     summary: Get vendor metrics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Vendor metrics retrieved successfully
 */
router.get("/vendors/metrics", authAdmin, authorizeAdmin, getVendorMetrics);

/**
 * @swagger
 * /admin/vendors:
 *   get:
 *     summary: Get all vendors
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Vendors retrieved successfully
 */
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
router.get("/vendors", authAdmin, authorizeAdmin, getVendors);



export default router;