import express from 'express';
import { getPendingPayouts, settlePayout, getFinanceKpis } from '../../controllers/Admin/financeController.js';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';

const router = express.Router();

/**
 * @swagger
 * /admin/finance/kpis:
 *   get:
 *     summary: Get finance KPIs
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Finance KPIs retrieved successfully
 */
router.get("/finance/kpis", authAdmin, authorizeAdmin, getFinanceKpis);

/**
 * @swagger
 * /admin/finance/payouts:
 *   get:
 *     summary: Get pending payouts
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pending payouts retrieved successfully
 */
router.get("/finance/payouts", authAdmin, authorizeAdmin, getPendingPayouts);

/**
 * @swagger
 * /admin/finance/payouts/{id}/settle:
 *   post:
 *     summary: Settle a payout
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payout settled successfully
 */
router.post("/finance/payouts/:id/settle", authAdmin, authorizeAdmin, settlePayout);

export default router;