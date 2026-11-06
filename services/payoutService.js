import prisma from "../util/prisma.js";
import { addPayoutJob } from "../queues/payoutQueue.js";
import { PAYOUT_READY_BOOKING_STATUSES, PAYOUT_DEAD_BOOKING_STATUSES, PAYOUT_BLOCKING_STATUSES, payoutAccountHoldReason } from "../util/payoutRules.js";

export { PAYOUT_READY_BOOKING_STATUSES, PAYOUT_DEAD_BOOKING_STATUSES };

/**
 * Thrown by service functions to carry an intended HTTP status code, so the
 * controller can map it to a response without the service layer knowing
 * anything about Express.
 */
export class PayoutError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'PayoutError';
    this.statusCode = statusCode;
  }
}

/**
 * Claims a payment for vendor payout settlement and queues the gateway call.
 *
 * Rather than calling the RazorpayX gateway synchronously, this:
 *   1. Opens a DB transaction that re-reads the payment and, in the same
 *      transaction, flips vendorPayoutStatus "pending" -> "processing".
 *      This is the row-level lock: a concurrent settle request for the same
 *      payment will read "processing" (not "pending") and be rejected before
 *      any money moves, closing the check-then-act race that would let the
 *      same payout be sent to the gateway twice.
 *   2. Once the transaction commits, enqueues a BullMQ job on the existing
 *      `payoutQueue` instead of hitting the gateway inline. The shared
 *      `payoutWorker` (workers/payoutWorker.js) performs the actual gateway
 *      call and the final "paid"/"failed" DB update, with BullMQ retries on
 *      transient failures.
 *
 * @param {number} paymentId - Payment.id to settle
 * @returns {Promise<{ payment: object }>} the payment, now in "processing" state
 * @throws {PayoutError} 400/404 on invalid/ineligible payment, 500 on transaction failure
 */
export const claimAndQueuePayout = async (paymentId) => {
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    throw new PayoutError("Invalid payment id", 400);
  }

  let payment;
  let vendorId;

  try {
    const txResult = await prisma.$transaction(async (tx) => {
      // Take a row lock BEFORE reading the payout status. The status flip
      // below is a check-then-act, and under the default Read Committed
      // isolation two concurrent settle requests could each read "pending",
      // each write "processing", and each enqueue a payout job for the same
      // payment. Locking the row first serialises them, so the loser reads
      // "processing" and is rejected before any money moves.
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId} FOR UPDATE`;

      const p = await tx.payment.findUnique({
        where: { id: paymentId },
        include: {
          booking: {
            include: { service: true }
          }
        }
      });

      if (!p) return { error: "Payment not found", status: 404 };
      if (p.status !== "success") return { error: "Payment not successful", status: 400 };

      if (p.vendorPayoutStatus === "settled" || p.vendorPayoutStatus === "paid") {
        return { error: "Already settled!", status: 400 };
      }
      if (p.vendorPayoutStatus === "processing") {
        return { error: "Payout already in progress", status: 400 };
      }

      // --- Refund guards ---
      //
      // These sit INSIDE the transaction on purpose. The row lock taken above
      // is the same lock refundService takes before reserving a refund
      // (`SELECT id FROM "Payment" ... FOR UPDATE`), so a payout and a refund
      // for the same payment are mutually exclusive: whichever gets the lock
      // second sees the other's work and backs off. Checking outside the
      // transaction would leave exactly the race this is meant to close —
      // a vendor being paid microseconds before a refund is reserved.

      // 1. A booking that is cancelled, refunded or disputed has no settled
      //    amount to pay out, whatever the payment row alone suggests.
      if (PAYOUT_DEAD_BOOKING_STATUSES.includes(p.booking?.status)) {
        return {
          error: `Payout blocked: booking is ${p.booking.status}`,
          status: 400,
        };
      }
      if (!PAYOUT_READY_BOOKING_STATUSES.includes(p.booking?.status)) {
        return {
          error: `Payout blocked: the job is not finished yet (booking is ${p.booking?.status ?? "missing"})`,
          status: 400,
        };
      }

      // 2. Any refund whose outcome is still open. Uses refundService's
      //    PAYOUT_BLOCKING_STATUSES so the two sides can't drift apart. A
      //    finished partial refund no longer blocks: it already cut
      //    vendorAmount to 90% of what is left (owner decision 2026-11-03).
      const reservedRefund = await tx.refund.findFirst({
        where: { paymentId: p.id, status: { in: PAYOUT_BLOCKING_STATUSES } },
        select: { id: true, status: true },
      });
      if (reservedRefund) {
        return {
          error: "Payout blocked: a refund is in progress for this payment",
          status: 400,
        };
      }

      // 3. The escrow hold set when the booking was completed. NULL means no
      //    hold was recorded (payments completed before this existed), which
      //    is treated as releasable rather than frozen forever.
      if (p.payoutHoldUntil && p.payoutHoldUntil > new Date()) {
        return {
          error: `Payout is still within the hold window (releasable at ${p.payoutHoldUntil.toISOString()})`,
          status: 400,
        };
      }

      // Handle Prisma Decimal correctly
      const vendorAmountInRupees = parseFloat(p.vendorAmount?.toString() || "0");
      if (!vendorAmountInRupees || vendorAmountInRupees <= 0) {
        return { error: "Zero amount or invalid vendor amount", status: 400 };
      }

      const vId = p.booking?.service?.vendorId;
      if (!vId) return { error: "Vendor not found for booking", status: 400 };

      // Security A-023: refuse while the vendor's payout account changed in
      // the last 24h. Nothing is claimed, so the payment stays "pending" and
      // the admin can settle it once the hold ends.
      const vp = await tx.vendorProfile.findUnique({
        where: { userId: vId },
        select: { payoutAccountChangedAt: true },
      });
      const hold = payoutAccountHoldReason(vp?.payoutAccountChangedAt);
      if (hold) return { error: hold, status: 409 };

      // Lock the row by marking it "processing" so concurrent settle
      // requests for the same payment can't both pass the checks above.
      await tx.payment.update({
        where: { id: p.id },
        data: { vendorPayoutStatus: "processing" }
      });

      // Enqueued INSIDE this transaction, using `tx` -- this used to run
      // after the transaction committed, with no retry. If that insert
      // failed, or the process died in the gap, the payment was left
      // permanently "processing" with no job to ever move it: every
      // recovery path is closed by design (this function's own checks above
      // reject re-claiming a "processing" payment). BackgroundJob is a
      // Postgres table, so this insert now commits or rolls back atomically
      // with the status flip -- an enqueue failure rolls the status flip
      // back too, instead of stranding it.
      await addPayoutJob(
        { paymentId: p.id, vendorId: vId, bookingId: p.bookingId },
        tx
      );

      return { payment: p, vendorId: vId };
    });

    if (txResult.error) {
      throw new PayoutError(txResult.error, txResult.status);
    }

    payment = txResult.payment;
    vendorId = txResult.vendorId;
  } catch (error) {
    if (error instanceof PayoutError) throw error;
    console.error("Settle payout transaction error:", error);
    throw new PayoutError("Failed to settle payout entirely", 500);
  }

  return { payment: { ...payment, vendorPayoutStatus: "processing" } };
};
