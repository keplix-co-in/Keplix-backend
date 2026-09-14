import express from 'express';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import { getVendorMetrics, getVendors, setVendorStatus } from '../../controllers/Admin/vendorController.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { setVendorStatusSchema } from '../../validators/Admin/vendorValidator.js';
const router = express.Router();

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
router.get("/vendors", authAdmin, authorizeAdmin, getVendors);




/**
 * PATCH /admin/vendors/:id/status
 *
 * The vendor approval gate. Previously absent entirely -- VendorProfile.status
 * defaulted to "pending" and no code path ever wrote it, so no vendor could be
 * approved and the nearby-vendor search (which filters on status = 'approved')
 * could never return a row.
 */
router.patch(
  "/vendors/:id/status",
  authAdmin,
  authorizeAdmin,
  validateRequest(setVendorStatusSchema),
  setVendorStatus,
);

export default router;
