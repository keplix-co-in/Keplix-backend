import prisma from "../util/prisma.js";
import { addPayoutJob } from "../queues/payoutQueue.js";

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

      // Handle Prisma Decimal correctly
      const vendorAmountInRupees = parseFloat(p.vendorAmount?.toString() || "0");
      if (!vendorAmountInRupees || vendorAmountInRupees <= 0) {
        return { error: "Zero amount or invalid vendor amount", status: 400 };
      }

      const vId = p.booking?.service?.vendorId;
      if (!vId) return { error: "Vendor not found for booking", status: 400 };

      // Lock the row by marking it "processing" so concurrent settle
      // requests for the same payment can't both pass the checks above.
      await tx.payment.update({
        where: { id: p.id },
        data: { vendorPayoutStatus: "processing" }
      });

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

  // Gateway call happens off the request thread, inside the payout worker.
  await addPayoutJob({
    paymentId: payment.id,
    vendorId,
    bookingId: payment.bookingId
  });

  return { payment: { ...payment, vendorPayoutStatus: "processing" } };
};
