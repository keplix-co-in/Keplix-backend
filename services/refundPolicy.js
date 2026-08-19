import prisma from "../util/prisma.js";
import Razorpay from "razorpay";
import { getPlatformSettings } from "../util/platformSettings.js";
import { issueRefund } from "./refundService.js";

/**
 * Refund POLICY.
 *
 * refundService.js is the mechanism — it moves money safely and says so
 * explicitly: "There is no product-defined refund/cancellation policy yet, so
 * this endpoint enforces no eligibility rule... Whatever refund
 * windows/conditions the business settles on should be enforced by the caller
 * (e.g. a booking-cancellation flow) before this is invoked."
 *
 * This file is that caller. It decides WHETHER and HOW MUCH; refundService
 * still decides that the money moves exactly once.
 *
 * Current policy:
 * - No cancellation fee, ever. Cancelling before the service starts returns
 *   the full booking amount.
 * - Cancellation stops being a refund once work has started. in_progress and
 *   later is a dispute, not a cancellation, and is deliberately left to a
 *   human — auto-refunding a job a vendor has already done is not recoverable
 *   through this path.
 * - Razorpay's own fee is not returned to us on a refund. Who absorbs it is
 *   PlatformSettings.refundGatewayFeeBorneBy.
 */

// Cancelling from these states is a clean "nothing has happened yet" refund.
const REFUNDABLE_BOOKING_STATUSES = ["pending", "confirmed", "scheduled"];

let razorpayClient = null;
const getRazorpay = () => {
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
};

/**
 * Razorpay's fee for a payment, in rupees, or null if it can't be determined.
 *
 * The fee isn't knowable from our side at capture time without this extra
 * call, so it's fetched lazily and cached onto Payment.gatewayFee.
 *
 * Returning null on any failure is deliberate and load-bearing: the caller
 * refunds the FULL amount when the fee is unknown. Guessing a deduction would
 * quietly short-change a customer because an unrelated API call failed.
 */
export const resolveGatewayFee = async (payment) => {
  if (payment.gatewayFee != null) return parseFloat(payment.gatewayFee.toString());
  if (!payment.transactionId) return null;

  try {
    const entity = await getRazorpay().payments.fetch(payment.transactionId);
    // `fee` is in paise and already includes `tax`.
    if (entity?.fee == null) return null;
    const feeInRupees = Number(entity.fee) / 100;
    if (!Number.isFinite(feeInRupees) || feeInRupees < 0) return null;

    await prisma.payment
      .update({ where: { id: payment.id }, data: { gatewayFee: feeInRupees } })
      .catch(() => {}); // cache only — a write failure must not block the refund

    return feeInRupees;
  } catch (error) {
    console.error("Could not fetch gateway fee for payment", payment.id, error.message);
    return null;
  }
};

/**
 * Decide what a cancellation of this booking is worth back to the customer.
 *
 * Pure apart from the settings/fee lookups, so the rules can be tested without
 * touching a gateway.
 *
 * @returns {{eligible: boolean, amount?: number, code: string, reason: string}}
 */
export const resolveCancellationRefund = async ({ booking, payment, settings }) => {
  const config = settings ?? (await getPlatformSettings());

  if (!payment) {
    return {
      eligible: false,
      code: "NO_PAYMENT",
      reason: "This booking was never paid for, so there is nothing to refund.",
    };
  }

  if (payment.status !== "success") {
    return {
      eligible: false,
      code: "PAYMENT_NOT_SUCCESSFUL",
      reason: `Payment is ${payment.status}, so there is nothing to refund.`,
    };
  }

  // Already cancelled. Reached when the preview endpoint is called on a
  // booking that was cancelled earlier — reporting "work has started" there
  // would be plainly wrong, and this is the state a customer revisiting a
  // cancelled booking is actually in.
  if (["cancelled", "canceled"].includes(booking.status)) {
    return {
      eligible: false,
      code: "ALREADY_CANCELLED",
      reason: "This booking is already cancelled. Any refund due is being handled separately.",
    };
  }

  // `booking.status` here is the status BEFORE the cancellation was applied —
  // callers must capture it first, or every cancellation would look like it
  // came from 'cancelled' and nothing would ever be refundable.
  if (!REFUNDABLE_BOOKING_STATUSES.includes(booking.status)) {
    return {
      eligible: false,
      code: "WORK_ALREADY_STARTED",
      reason:
        `Booking is ${booking.status}; once work has started this needs review rather than ` +
        `an automatic refund.`,
    };
  }

  const paidAmount = parseFloat(payment.amount.toString());
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    return {
      eligible: false,
      code: "INVALID_AMOUNT",
      reason: "Payment amount could not be read.",
    };
  }

  // No cancellation fee under current policy — the only possible deduction is
  // the gateway's own non-returnable cut.
  let amount = paidAmount;
  let feeDeducted = 0;

  if (config.refundGatewayFeeBorneBy === "customer") {
    const fee = await resolveGatewayFee(payment);
    if (fee != null && fee < paidAmount) {
      feeDeducted = fee;
      amount = paidAmount - fee;
    }
    // fee unknown, or somehow >= the payment: refund in full rather than guess.
  }

  return {
    eligible: true,
    amount: Math.round(amount * 100) / 100,
    feeDeducted,
    code: "CANCELLATION_REFUND",
    reason: feeDeducted
      ? `Full refund less the ₹${feeDeducted.toFixed(2)} payment-gateway fee.`
      : "Full refund.",
  };
};

/**
 * Decide, then issue.
 *
 * The idempotency key is derived from the booking and amount, so a
 * double-tapped cancel resolves to the same key and refundService returns the
 * original refund instead of issuing a second one.
 *
 * Never throws: cancellation has already been committed by the caller, and a
 * gateway problem must not turn a successful cancellation into a 500. The
 * outcome is returned for logging/notification instead.
 */
export const executeCancellationRefund = async ({ booking, payment }) => {
  const settings = await getPlatformSettings();

  if (!settings.autoRefundOnCancellation) {
    return { refunded: false, code: "AUTO_REFUND_DISABLED", reason: "Automatic refunds are turned off." };
  }

  const decision = await resolveCancellationRefund({ booking, payment, settings });
  if (!decision.eligible) return { refunded: false, ...decision };

  try {
    const result = await issueRefund({
      paymentId: payment.id,
      amount: decision.amount,
      reason: `Booking #${booking.id} cancelled by customer`,
      idempotencyKey: `cancel_booking_${booking.id}_${decision.amount.toFixed(2)}`,
    });

    return {
      refunded: true,
      amount: decision.amount,
      feeDeducted: decision.feeDeducted,
      alreadyProcessed: result.alreadyProcessed,
      payoutAlreadySettled: result.payoutAlreadySettled,
      refund: result.refund,
      code: "REFUND_ISSUED",
      reason: decision.reason,
    };
  } catch (error) {
    console.error(`Cancellation refund failed for booking ${booking.id}:`, error.message);
    return { refunded: false, code: "REFUND_FAILED", reason: error.message };
  }
};
