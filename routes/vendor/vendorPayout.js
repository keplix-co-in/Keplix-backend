import express from "express";
import rateLimit from "express-rate-limit";
import { triggerVendorPayout } from "../../controllers/vendor/vendorPayoutController.js";
import { protect } from "../../middleware/authMiddleware.js";


const router = express.Router();
const vendorPayoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many payout requests. Please try again later." },
});

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
router.post("/vendor/payout", vendorPayoutLimiter, protect, triggerVendorPayout );

export default router;