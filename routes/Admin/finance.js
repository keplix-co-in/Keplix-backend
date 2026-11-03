import express from 'express';
import { getPendingPayouts, settlePayout, getFinanceKpis, refundPayment, getRefunds } from '../../controllers/Admin/financeController.js';
import { authAdmin, authorizeAdmin, authorizeSuperAdmin } from '../../middleware/authAdminMiddleware.js';

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
 * /admin/finance/refunds:
 *   get:
 *     summary: List refunds of every kind, plus paid cancelled bookings still owed a refund
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [all, needs_refund, processing, refunded, failed]
 *     responses:
 *       200:
 *         description: "{ group, items: [...] }"
 *       400:
 *         description: Unknown status filter
 */
router.get("/finance/refunds", authAdmin, authorizeAdmin, getRefunds);

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
// Money actually leaves Keplix's account here -- restricted to super_admin
// (audit #108). Ordinary admin still sees the pending-payouts list above.
router.post("/finance/payouts/:id/settle", authAdmin, authorizeAdmin, authorizeSuperAdmin, settlePayout);

/**
 * @swagger
 * /admin/finance/payments/{id}/refund:
 *   post:
 *     summary: Issue a full or partial refund for a payment
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - idempotencyKey
 *             properties:
 *               amount:
 *                 type: number
 *                 description: Rupees; omit for a full refund of the remaining amount
 *               reason:
 *                 type: string
 *               idempotencyKey:
 *                 type: string
 *                 description: Stable per refund intent — resending with the same key returns the original refund
 *     responses:
 *       200:
 *         description: Refund processed
 */
// Same reasoning as settle above: an actual gateway refund, super_admin only.
router.post("/finance/payments/:id/refund", authAdmin, authorizeAdmin, authorizeSuperAdmin, refundPayment);

export default router;