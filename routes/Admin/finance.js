import express from 'express';
import { getPendingPayouts, settlePayout } from '../../controllers/Admin/financeController.js';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';

const router = express.Router();

router.get("/finance/payouts", authAdmin, authorizeAdmin, getPendingPayouts);
router.post("/finance/payouts/:id/settle", authAdmin, authorizeAdmin, settlePayout);

export default router;