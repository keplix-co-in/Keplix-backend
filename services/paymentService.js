import crypto from "crypto";
import prisma from "../util/prisma.js";

const CASH_LIKE_GATEWAYS = ['cash', 'card', 'upi', 'netbanking'];
const PLATFORM_FEE_PERCENTAGE = 0.1; // 10% fee

/**
 * Thrown by service functions to carry an intended HTTP status code, so the
 * controller can map it to a response without the service layer knowing
 * anything about Express.
 */
export class PaymentError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'PaymentError';
    this.statusCode = statusCode;
  }
}

/**
 * Verifies a payment and records it, deriving the authoritative amount from
 * the booking's service price rather than trusting any client-supplied
 * amount. For online gateways (razorpay/stripe/etc.) the Razorpay HMAC
 * signature is checked; for cash-like methods (cash/card/upi/netbanking,
 * i.e. no online gateway involved) the booking must belong to the
 * requesting user instead.
 *
 * @param {object} params
 * @param {number} params.bookingId
 * @param {number} params.requestingUserId - req.user.id of the authenticated caller
 * @param {string} [params.orderId] - Razorpay order id (required for online gateways)
 * @param {string} [params.paymentId] - Razorpay payment id (required for online gateways)
 * @param {string} [params.signature] - Razorpay signature (required for online gateways)
 * @param {string} [params.gateway] - Payment method; defaults to "razorpay"
 * @returns {Promise<{ payment: object, updatedBooking: object|null, platformFee: number, vendorAmount: number }>}
 * @throws {PaymentError} 400/403/404 on invalid input, unauthorized booking, or bad signature
 */
export const verifyAndRecordPayment = async ({
  bookingId,
  requestingUserId,
  orderId,
  paymentId,
  signature,
  gateway,
}) => {
  if (!bookingId) {
    throw new PaymentError("Booking ID is required", 400);
  }

  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    include: { service: true },
  });

  if (!booking || !booking.service) {
    throw new PaymentError("Booking not found", 404);
  }

  const isCashLike = CASH_LIKE_GATEWAYS.includes(gateway);

  if (isCashLike) {
    if (booking.userId !== requestingUserId) {
      throw new PaymentError("Not authorized for this booking", 403);
    }
  } else {
    const body = orderId + "|" + paymentId;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== signature) {
      throw new PaymentError("Invalid payment signature", 400);
    }
  }

  const totalAmount = parseFloat(booking.service.price.toString());
  const platformFee = totalAmount * PLATFORM_FEE_PERCENTAGE;
  const vendorAmount = totalAmount - platformFee;

  const paymentData = {
    amount: totalAmount,
    currency: "INR",
    status: "success",
    method: gateway || "razorpay",
    transactionId: paymentId || `TXN${Date.now()}`,
    platformFee,
    vendorAmount,
    vendorPayoutStatus: "pending",
  };

  // Payment record + booking status update must commit together — if the
  // booking update failed after the payment was already saved, we'd have
  // a "paid" payment left dangling with no confirmed booking.
  const { payment, updatedBooking } = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.upsert({
      where: { bookingId: Number(bookingId) },
      update: paymentData,
      create: {
        bookingId: Number(bookingId),
        ...paymentData,
      },
    });

    const updatedBooking = await tx.booking.update({
      where: { id: Number(bookingId) },
      data: { status: "confirmed" },
      include: { service: true },
    });

    return { payment, updatedBooking };
  });

  return { payment, updatedBooking, platformFee, vendorAmount };
};
