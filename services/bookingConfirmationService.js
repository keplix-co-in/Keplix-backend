import prisma from "../util/prisma.js";
import { addPayoutJob } from "../queues/payoutQueue.js";
import { updateVendorRatingStats } from "../util/ratingHelper.js";

/**
 * Thrown by service functions to carry an intended HTTP status code, so the
 * controller can map it to a response without the service layer knowing
 * anything about Express.
 */
export class BookingConfirmationError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'BookingConfirmationError';
    this.statusCode = statusCode;
  }
}

// Errors from inside the transaction that should map to 400 (client-fixable)
// rather than 500 (server fault).
const CLIENT_ERROR_MESSAGES = [
  "Booking status has changed",
  "No payment found",
  "Payment not successful",
  "Vendor payout already processed",
];

/**
 * Confirms a user's booking as satisfactorily completed: updates the
 * booking status, optionally records a review (and updates the vendor's
 * incremental rating), then claims the payment for payout by marking it
 * "processing" and queuing the gateway call via BullMQ — all inside a
 * single transaction so the booking/review/payout-claim state can't
 * diverge if one step fails.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {number} params.bookingId
 * @param {number} [params.rating] - 1-5 star rating; review is skipped if omitted
 * @param {string} [params.comment]
 * @returns {Promise<void>}
 * @throws {BookingConfirmationError} 400/403/404 depending on the failure
 */
export const confirmBookingAndQueuePayout = async ({ userId, bookingId, rating, comment }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      service: { select: { vendorId: true, name: true } },
      payment: true
    }
  });

  if (!booking) {
    throw new BookingConfirmationError("Booking not found", 404);
  }

  if (booking.userId !== userId) {
    throw new BookingConfirmationError("Not authorized to confirm this booking", 403);
  }

  if (booking.status !== "service_completed") {
    throw new BookingConfirmationError(
      "Cannot confirm booking. Vendor must mark service as completed first.",
      400
    );
  }

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // Lock the booking's payment row before reading its payout status.
      // This is the second of two independent paths that can enqueue a payout
      // (the other is the admin settle in services/payoutService.js), so
      // without a lock a customer confirmation racing an admin settle can
      // both read a non-terminal status and both enqueue for the same payment.
      await tx.$queryRaw`SELECT p.id FROM "Payment" p WHERE p."bookingId" = ${bookingId} FOR UPDATE`;

      const currentBooking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          service: { select: { vendorId: true, name: true } },
          payment: true
        }
      });

      if (currentBooking.status !== "service_completed") {
        throw new Error(`Booking status has changed to ${currentBooking.status}`);
      }

      const payment = currentBooking.payment;
      if (!payment) {
        throw new Error("No payment found for this booking");
      }

      if (payment.status !== "success") {
        throw new Error("Payment not successful, cannot process payout");
      }

      // "processing" and "settled" are just as disqualifying as "paid" — they
      // mean another path (admin settle) has already claimed this payout and
      // a job is in flight. Checking only "paid" let a confirmation enqueue a
      // duplicate job for a payout that was already under way.
      if (["paid", "settled", "processing"].includes(payment.vendorPayoutStatus)) {
        throw new Error("Vendor payout already processed");
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "user_confirmed" }
      });

      if (rating !== undefined && rating !== null) {
        const ratingValue = Math.round(parseFloat(rating));
        if (!isNaN(ratingValue)) {
          const vendorId = currentBooking.service?.vendorId;

          const existingReview = await tx.review.findUnique({
            where: { bookingId: bookingId }
          });

          if (!existingReview) {
            await tx.review.create({
              data: {
                bookingId: bookingId,
                userId: userId,
                vendorId: vendorId,
                rating: ratingValue,
                comment: comment || null
              }
            });

            if (vendorId) {
              await updateVendorRatingStats(tx, vendorId);
            }
          }
        }
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: { vendorPayoutStatus: "processing" }
      });

      return {
        paymentId: payment.id,
        vendorId: currentBooking.service.vendorId,
        bookingId: bookingId
      };
    }, {
      timeout: 20000 // External payout APIs can be slow
    });
  } catch (error) {
    if (CLIENT_ERROR_MESSAGES.some(msg => error.message.includes(msg))) {
      throw new BookingConfirmationError(error.message, 400);
    }
    throw error;
  }

  // Gateway call happens off the request thread, inside the payout worker.
  await addPayoutJob({
    paymentId: result.paymentId,
    vendorId: result.vendorId,
    bookingId: result.bookingId
  });
};
