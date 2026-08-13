import prisma from "../../util/prisma.js";
import { claimAndQueuePayout, PayoutError } from "../../services/payoutService.js";
import { issueRefund, RefundError } from "../../services/refundService.js";

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
                    id: true,
                    vendorProfile: {
                      select: { business_name: true, city: true }
                    },
                    // A payout hard-fails without an active payout account
                    // (util/payoutHelper.js throws). Fetching it here lets the
                    // admin see the problem BEFORE clicking Pay Now, rather
                    // than queueing a job that is guaranteed to fail.
                    VendorPayoutAccount: {
                      select: { isActive: true }
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

    // Flatten the payout-readiness check into a flag the UI can act on.
    const withReadiness = payouts.map((p) => {
      const account = p.booking?.service?.vendor?.VendorPayoutAccount;
      return {
        ...p,
        payoutReady: Boolean(account?.isActive),
        payoutBlockedReason: !account
          ? 'Vendor has no payout account — they must add bank/UPI details before this can be settled.'
          : (!account.isActive ? 'Vendor payout account is inactive.' : null),
      };
    });

    res.json(withReadiness);
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

/**
 * refundPayment
 *
 * Admin-only. Issues a full or partial refund via Razorpay for a successful
 * payment. Requires the caller to supply an idempotencyKey — retrying the
 * same request (network blip, accidental double-click) with the same key
 * returns the original refund instead of issuing a second one.
 *
 * There is no product-defined refund/cancellation policy yet, so this
 * endpoint enforces no eligibility rule beyond "payment is successful and
 * the amount is available" — it's a mechanism, not a policy. Whatever
 * refund windows/conditions the business settles on should be enforced by
 * the caller (e.g. a booking-cancellation flow) before this is invoked.
 */
export const refundPayment = async (req, res) => {
  try {
    const paymentId = Number(req.params.id);
    const { amount, reason, idempotencyKey } = req.body;

    if (!idempotencyKey) {
      return res.status(400).json({ success: false, message: "idempotencyKey is required" });
    }

    const result = await issueRefund({
      paymentId,
      amount,
      reason,
      idempotencyKey,
      initiatedBy: req.user?.id,
    });

    res.json({
      success: true,
      refund: result.refund,
      alreadyProcessed: result.alreadyProcessed,
      payoutAlreadySettled: result.payoutAlreadySettled,
      message: result.payoutAlreadySettled
        ? "Refund processed. The vendor's payout for this booking was already settled — this amount needs to be manually recovered from the vendor."
        : "Refund processed",
    });
  } catch (error) {
    console.error("Refund error:", error);
    if (error instanceof RefundError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: error.message || "Refund failed" });
  }
};
