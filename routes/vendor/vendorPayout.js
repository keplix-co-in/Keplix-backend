import express from "express";
import { triggerVendorPayout } from "../../controllers/vendor/vendorPayoutController.js";
import { protect } from "../../middleware/authMiddleware.js";
import { validateRequest } from "../../middleware/validationMiddleware.js"; // don't have schema for this yet


const router = express.Router();

/**
 * @swagger
 * /service_api/vendor/payout:
 *   post:
 *     summary: Trigger a payout for the vendor
 *     tags: [Vendor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: number
 *     responses:
 *       200:
 *         description: Payout triggered successfully
 */
router.post("/vendor/payout", protect, triggerVendorPayout );

export default router;