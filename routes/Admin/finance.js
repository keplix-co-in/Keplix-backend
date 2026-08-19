import express from 'express';
<<<<<<< HEAD
import { getPendingPayouts, settlePayout, getFinanceKpis } from '../../controllers/Admin/financeController.js';
=======
import { getPendingPayouts, settlePayout, getFinanceKpis, refundPayment } from '../../controllers/Admin/financeController.js';
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';

const router = express.Router();

<<<<<<< HEAD
router.get("/finance/kpis", authAdmin, authorizeAdmin, getFinanceKpis);
router.get("/finance/payouts", authAdmin, authorizeAdmin, getPendingPayouts);
router.post("/finance/payouts/:id/settle", authAdmin, authorizeAdmin, settlePayout);

=======
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
router.post("/finance/payments/:id/refund", authAdmin, authorizeAdmin, refundPayment);

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
export default router;