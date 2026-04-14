import express from 'express';
import { getPendingPayouts, settlePayout, getFinanceKpis } from '../../controllers/Admin/financeController.js';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';

const router = express.Router();

router.get("/finance/kpis", authAdmin, authorizeAdmin, getFinanceKpis);
router.get("/finance/payouts", authAdmin, authorizeAdmin, getPendingPayouts);
router.post("/finance/payouts/:id/settle", authAdmin, authorizeAdmin, settlePayout);

export default router;