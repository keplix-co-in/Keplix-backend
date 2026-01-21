import express from "express";;
import { triggerVendorPayout } from "../../controllers/vendor/vendorPayoutController.js";
import { protect } from "../../middleware/authMiddleware.js";
import { validateRequest } from "../../middleware/validationMiddleware.js"; // don't have schema for this yet


const router = express.Router();

router.post("/vendor/payout", protect, triggerVendorPayout );