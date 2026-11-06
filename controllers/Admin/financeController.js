import prisma from "../../util/prisma.js";
import { claimAndQueuePayout, PayoutError } from "../../services/payoutService.js";
import { issueRefund, RefundError, GATEWAY_REACHED_STATUSES } from "../../services/refundService.js";
import { PAYOUT_DEAD_BOOKING_STATUSES } from "../../util/payoutRules.js";

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
      // Total Collected in Escrow. Was `status: "success"` only -- a full
      // refund moves a payment out of 'success' into 'refunded', which
      // retroactively erased it from this historical total the moment it was
      // refunded. Collections are a fact of what happened; the refund is
      // shown as its own separate deduction below, not by hiding the payment.
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: { in: ["success", "refunded"] } }
      }),
      // Disbursed to Vendors
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        where: { vendorPayoutStatus: { in: ["settled", "paid"] }, status: "success" }
      }),
      // Platform Commission: the 10% Keplix keeps from customer bookings.
      // 2026-11-03: only booking payments count (bookingId set) -- vendor
      // subscription / ad payments are not commission. A FULLY refunded
      // booking ('refunded') kept nothing either, since the customer got the
      // whole amount back. A partial refund stays 'success' and its fee is
      // already cut to 10% of what is left (refundService.recomputeSplitAfterRefunds).
      prisma.payment.aggregate({
        _sum: { platformFee: true },
        where: { status: "success", bookingId: { not: null } }
      }),
      // Pending Disbursement. Was missing "processing" -- a payment claimed
      // for payout but stranded there if the queue enqueue failed (see the
      // audit's F42) was invisible here, with no KPI ever showing it needed
      // attention.
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        // 2026-11-03: same dead-booking filter as the Payout Queue. Without it a
        // cancelled / refunded / disputed booking counted here as "owed to the
        // vendor" (prod showed ₹3,814 pending while the queue was empty).
        where: {
          vendorPayoutStatus: { in: ["pending", "processing"] },
          status: "success",
          booking: { status: { notIn: PAYOUT_DEAD_BOOKING_STATUSES } }
        }
      }),
      // Refunds Issued. Was summing Payment.amount where status:"refunded",
      // which refundService.js only sets on a FULL refund -- every partial
      // refund contributed zero. Refund is the table that actually records
      // refund amounts; GATEWAY_REACHED_STATUSES (imported, not re-listed) is
      // refundService's own definition of "this refund actually reached the
      // gateway", so this figure can't silently drift from what /refund
      // actually does.
      prisma.refund.aggregate({
        _sum: { amount: true },
        where: { status: { in: GATEWAY_REACHED_STATUSES } }
      }),
      // Failed Payouts. Had no `status` filter at all, unlike every sibling
      // query here -- summing vendorAmount across payments regardless of
      // whether the payment itself ever succeeded.
      prisma.payment.aggregate({
        _sum: { vendorAmount: true },
        where: {
          vendorPayoutStatus: "failed",
          status: "success",
          booking: { status: { notIn: PAYOUT_DEAD_BOOKING_STATUSES } }
        }
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
        // 'failed' is listed too (2026-11-03) so admin can retry it -- before,
        // a failed payout was only a number in the KPIs with no way to act.
        vendorPayoutStatus: { in: ["pending", "failed"] },
        status: "success",
        // A cancelled / refunded / disputed booking owes the vendor nothing;
        // listing it made it look owed and Pay Now then failed on it.
        booking: { status: { notIn: PAYOUT_DEAD_BOOKING_STATUSES } }
      },
      select: {
        id: true,
        vendorAmount: true,
        vendorPayoutStatus: true,
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
    // Security A-008: error.message (Prisma/driver/gateway internals) is logged, never returned.
    res.status(500).json({ success: false, message: "Failed to settle payout entirely" });
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
        // "sent", not "processed": Razorpay often answers 'pending' and the
        // money lands later. The Refunds list shows when it is done.
        ? "Refund sent to Razorpay. The vendor's payout for this booking was already settled — this amount needs to be manually recovered from the vendor."
        : "Refund sent to Razorpay",
    });
  } catch (error) {
    console.error("Refund error:", error);
    if (error instanceof RefundError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    // Security A-008: error.message (Prisma/driver/gateway internals) is logged, never returned.
    res.status(500).json({ success: false, message: "Refund failed" });
  }
};

// Paid bookings in these states should have had their money returned.
const REFUND_EXPECTED_BOOKING_STATUSES = ["cancelled", "canceled", "refunded"];

// Refund.status -> the group the admin filters by.
const REFUND_GROUP_OF = {
  initiated: "processing",
  gateway_confirmed: "processing",
  processed: "refunded",
  // The money did go back; only our own bookkeeping after it failed.
  reconciliation_needed: "refunded",
  gateway_failed: "failed",
};
export const REFUND_LIST_GROUPS = ["all", "needs_refund", "processing", "refunded", "failed"];

const REFUND_LIST_PAYMENT_SELECT = {
  id: true,
  amount: true,
  transactionId: true,
  status: true,
  vendorPayoutStatus: true,
  booking: {
    select: {
      id: true,
      status: true,
      user: { select: { id: true, email: true } },
      service: {
        select: {
          name: true,
          vendor: { select: { id: true, vendorProfile: { select: { business_name: true } } } },
        },
      },
    },
  },
};

const bookingSummary = (payment) => ({
  bookingId: payment?.booking?.id ?? null,
  bookingStatus: payment?.booking?.status ?? null,
  service: payment?.booking?.service?.name ?? null,
  customer: payment?.booking?.user ?? null,
  vendor: payment?.booking?.service?.vendor
    ? {
        id: payment.booking.service.vendor.id,
        name: payment.booking.service.vendor.vendorProfile?.business_name ?? null,
      }
    : null,
});

/**
 * getRefunds -- the admin "Refunds" list (2026-11-03).
 *
 * One list of every refund of any kind, plus the ones that SHOULD exist but
 * don't: a paid booking that was cancelled (or marked refunded) where no
 * refund has gone out or is under way. Those show as "needs_refund" so an
 * admin can send it -- before this, such a booking left no trace anywhere.
 *
 * Query: ?status=all|needs_refund|processing|refunded|failed (default all)
 */
export const getRefunds = async (req, res) => {
  try {
    const group = req.query?.status || "all";
    if (!REFUND_LIST_GROUPS.includes(group)) {
      return res.status(400).json({ message: `Unknown refund filter: ${String(group)}`, allowed: REFUND_LIST_GROUPS });
    }

    const wantRows = group !== "needs_refund";
    const wantNeeds = group === "all" || group === "needs_refund";
    const rowStatuses = wantRows && group !== "all"
      ? Object.keys(REFUND_GROUP_OF).filter((s) => REFUND_GROUP_OF[s] === group)
      : null;

    const [refundRows, unrefunded] = await Promise.all([
      wantRows
        ? prisma.refund.findMany({
            where: rowStatuses ? { status: { in: rowStatuses } } : {},
            orderBy: { createdAt: "desc" },
            take: 200,
            include: { payment: { select: REFUND_LIST_PAYMENT_SELECT } },
          })
        : [],
      wantNeeds
        ? prisma.payment.findMany({
            where: {
              status: "success",
              booking: { status: { in: REFUND_EXPECTED_BOOKING_STATUSES } },
              // Nothing returned and nothing on its way. A failed attempt
              // does not count, so it shows here again as still owed.
              refunds: { none: { status: { in: ["initiated", ...GATEWAY_REACHED_STATUSES] } } },
            },
            orderBy: { createdAt: "desc" },
            take: 200,
            select: REFUND_LIST_PAYMENT_SELECT,
          })
        : [],
    ]);

    const needs = unrefunded.map((p) => ({
      kind: "needs_refund",
      group: "needs_refund",
      refundId: null,
      paymentId: p.id,
      amount: Number(p.amount),
      status: "needs_refund",
      reason: "Paid booking was cancelled but no refund has been sent",
      gatewayRefundId: null,
      gatewayPaymentId: p.transactionId,
      vendorPayoutStatus: p.vendorPayoutStatus,
      createdAt: null,
      ...bookingSummary(p),
    }));

    const rows = refundRows.map((r) => ({
      kind: "refund",
      group: REFUND_GROUP_OF[r.status] || "processing",
      refundId: r.id,
      paymentId: r.paymentId,
      amount: Number(r.amount),
      status: r.status,
      reason: r.reason,
      // Who started it: an admin id, or null for automatic / dashboard refunds.
      initiatedBy: r.initiatedBy,
      fromDashboard: String(r.idempotencyKey || "").startsWith("dashboard:"),
      lastError: r.lastError,
      gatewayRefundId: r.gatewayRefundId,
      gatewayPaymentId: r.payment?.transactionId ?? null,
      vendorPayoutStatus: r.payment?.vendorPayoutStatus ?? null,
      createdAt: r.createdAt,
      ...bookingSummary(r.payment),
    }));

    // Owed refunds first: they are the ones that need someone to act.
    res.json({ group, items: [...needs, ...rows] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch refunds" });
  }
};
