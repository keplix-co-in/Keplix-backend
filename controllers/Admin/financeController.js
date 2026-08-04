import prisma from "../../util/prisma.js";
import { claimAndQueuePayout, PayoutError } from "../../services/payoutService.js";

export const getFinanceKpis = async (req, res) => {
  try {
    const [
      totalCollected,
      disbursed,
      commission,
      pendingDisbursement,
      refunds,
      failed
    ] = await Promise.all([
      // Total Collected in Escrow
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: "success" }
      }),
      // Disbursed to Vendors
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        where: { vendorPayoutStatus: { in: ["settled", "paid"] }, status: "success" }
      }),
      // Platform Commission
      prisma.payment.aggregate({
        _sum: { platformFee: true },
        where: { status: "success" }
      }),
      // Pending Disbursement
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        where: { vendorPayoutStatus: "pending", status: "success" }
      }),
      // Refunds Issued
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: "refunded" }
      }),
      // Failed Payouts
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        where: { vendorPayoutStatus: "failed" }
      })
    ]);

    res.json({
      totalCollected: totalCollected._sum.amount || 0,
      disbursed: disbursed._sum.vendorAmount || 0,
      commission: commission._sum.platformFee || 0,
      pendingDisbursement: pendingDisbursement._sum.vendorAmount || 0,
      refunds: refunds._sum.amount || 0,
      failed: failed._sum.vendorAmount || 0
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch finance KPIs" });
  }
};

export const getPendingPayouts = async (req, res) => {
  try {
    const payouts = await prisma.payment.findMany({
      where: {
        vendorPayoutStatus: "pending",
        status: "success"
      },
      select: {
        id: true,
        vendorAmount: true,
        createdAt: true,
        booking: {
          select: {
            id: true,
            service: {
              select: {
                name: true,
                vendor: {
                  select: {
                    vendorProfile: {
                      select: { business_name: true, city: true }
                    }
                  }
                }
              }
            },
            vendor_status: true
          }
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    res.json(payouts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch payouts" });
  }
};

/**
 * settlePayout
 *
 * Admin-triggered vendor payout settlement. Rather than calling the RazorpayX
 * gateway synchronously on the request thread, this handler:
 *   1. Opens a DB transaction that re-reads the payment and, in the same
 *      transaction, flips vendorPayoutStatus "pending" -> "processing".
 *      This is the row-level lock: a concurrent settle request for the same
 *      payment will read "processing" (not "pending") and be rejected before
 *      any money moves, closing the check-then-act race that let the same
 *      payout be sent to the gateway twice.
 *   2. Once the transaction commits, enqueues a BullMQ job on the existing
 *      `payoutQueue` instead of hitting the gateway inline. The shared
 *      `payoutWorker` (workers/payoutWorker.js) performs the actual gateway
 *      call and the final "paid"/"failed" DB update, with BullMQ retries on
 *      transient failures.
 *   3. Responds immediately (202) with the payment now in "processing" state;
 *      the admin UI can poll/refresh to see the final "paid" status.
 *
 * Params:
 *   req.params.id - Payment.id (numeric string) to settle
 *
 * Responses:
 *   202 { success: true, message, payment } - queued for async processing
 *   400 { success: false, message } - invalid id / not eligible for payout
 *   404 { success: false, message } - payment not found
 *   500 { success: false, message } - transaction or queueing failure
 */
export const settlePayout = async (req, res) => {
  try {
    const paymentId = Number(req.params.id);

    const { payment } = await claimAndQueuePayout(paymentId);

    res.status(202).json({
      success: true,
      message: "Payout queued for processing",
      payment
    });
  } catch (error) {
    console.error("Payout Gateway Error: ", error);
    if (error instanceof PayoutError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: error.message || "Failed to settle payout entirely" });
  }
};
