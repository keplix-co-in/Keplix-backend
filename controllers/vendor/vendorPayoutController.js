import Razorpay from "razorpay";
import { PrismaClient } from "@prisma/client";
import { initiateVendorPayout } from "../../util/payoutHelper.js";

const prisma = new PrismaClient();

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
     * 1️Payment fetch with booking and service details
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
     * Vendor ID fetch
     * Booking → Service → vendorId (User.id)
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
