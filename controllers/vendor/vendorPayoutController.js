import Razorpay from "razorpay";
import prisma from "../../util/prisma.js";
import { initiateVendorPayout } from "../../util/payoutHelper.js";
import { RESERVED_STATUSES } from "../../services/refundService.js";



/**
 * RazorpayX instance
 */
const razorpayX = new Razorpay({
  key_id: process.env.RAZORPAYX_KEY_ID,
  key_secret: process.env.RAZORPAYX_KEY_SECRET,
});

/**
 * @desc    Trigger Vendor Payout
 * @route   POST /service_api/admin/vendor/payout
 * @access  Admin / System
 */
export const triggerVendorPayout = async (req, res) => {
  try {
    const { paymentId } = req.body;

    if (!paymentId) {
      return res.status(400).json({ message: "paymentId is required" });
    }

    /**
     * 1ï¸Payment fetch with booking and service details
     */
    const payment = await prisma.payment.findUnique({
      where: { id: Number(paymentId) },
      include: {
        booking: {
          include: {
            service: true,
          },
        },
      },
    });

    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    if (payment.status !== "success") {
      return res.status(400).json({ message: "Payment not successful" });
    }

    if (payment.vendorPayoutStatus !== "pending") {
      return res
        .status(400)
        .json({ message: "Vendor payout already processed" });
    }

    /**
     * Refund guards.
     *
     * Previously this function checked only that the payment succeeded and
     * hadn't already been paid out, so a vendor could withdraw their share
     * before a refund was issued against the same payment. refundService
     * detects that only after the fact — it returns `payoutAlreadySettled`,
     * whose own comment says the money "needs to be manually recovered from
     * the vendor" with no mechanism to do it. These three checks are what
     * stop that race reaching the gateway.
     */

    // 1. A booking that is cancelled, refunded or under dispute has no
    //    settled amount to pay out yet, whatever the payment row says.
    const bookingStatus = payment.booking?.status;
    if (["cancelled", "refunded", "disputed"].includes(bookingStatus)) {
      return res.status(400).json({
        message: `Payout is blocked while this booking is ${bookingStatus}.`,
        code: "PAYOUT_BLOCKED_BOOKING_STATUS",
      });
    }

    // 2. Any refund already laying claim to this payment — using refundService's
    //    own definition of "reserved" so the two can't drift apart.
    const reservedRefund = await prisma.refund.findFirst({
      where: { paymentId: payment.id, status: { in: RESERVED_STATUSES } },
      select: { id: true, status: true },
    });
    if (reservedRefund) {
      return res.status(400).json({
        message: "Payout is blocked: a refund is in progress for this payment.",
        code: "PAYOUT_BLOCKED_REFUND_PENDING",
      });
    }

    // 3. The escrow hold window set at completion. NULL means no hold was
    //    recorded (e.g. bookings completed before this existed), which is
    //    treated as releasable rather than frozen forever.
    if (payment.payoutHoldUntil && payment.payoutHoldUntil > new Date()) {
      return res.status(400).json({
        message: "Payout is still within the hold window after service completion.",
        code: "PAYOUT_HOLD_ACTIVE",
        releasableAt: payment.payoutHoldUntil,
      });
    }

    /**
     * Vendor ID fetch
     * Booking â†’ Service â†’ vendorId (User.id)
     */
    const vendorId = payment.booking?.service?.vendorId;

    if (!vendorId) {
      return res.status(400).json({ message: "Vendor not found for booking" });
    }

    /**
     * Vendor payout account fetch 
     */
    const payoutAccount = await prisma.vendorPayoutAccount.findUnique({
      where: { vendorId },
    });

    if (!payoutAccount || !payoutAccount.isActive) {
      return res.status(400).json({
        message: "Vendor payout account not found or inactive",
      });
    }

    /**
     * Initiate payout using the helper function
     */
    const payoutResult = await initiateVendorPayout(payment, vendorId);

    if (!payoutResult.success) {
      return res.status(500).json({
        message: "Vendor payout failed",
        error: payoutResult.error,
      });
    }

    /**
     * Payment table update 
     */
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        vendorPayoutStatus: "paid",
        vendorPayoutId: payoutResult.payoutId,
      },
    });

    res.json({
      success: true,
      message: "Vendor payout successful",
      payoutId: payoutResult.payoutId,
      amount: payment.vendorAmount,
    });
  } catch (error) {
    console.error("Vendor payout error:", error);
    res.status(500).json({
      message: "Vendor payout failed",
      error: error.message,
    });
  }
};




