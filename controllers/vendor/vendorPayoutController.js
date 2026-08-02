import Razorpay from "razorpay";
import prisma from "../../util/prisma.js";
import { initiateVendorPayout } from "../../util/payoutHelper.js";



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
     * Step 1: Atomically verify payment status and lock it to "processing"
     * inside a transaction to prevent double-payout race conditions.
     */
    let payment;
    let vendorId;

    try {
      const txResult = await prisma.$transaction(async (tx) => {
        const p = await tx.payment.findUnique({
          where: { id: Number(paymentId) },
          include: {
            booking: {
              include: {
                service: true,
              },
            },
          },
        });

        if (!p) {
          return { error: "Payment not found", status: 404 };
        }

        if (p.status !== "success") {
          return { error: "Payment not successful", status: 400 };
        }

        if (p.vendorPayoutStatus !== "pending") {
          return { error: "Vendor payout already processed", status: 400 };
        }

        const vId = p.booking?.service?.vendorId;
        if (!vId) {
          return { error: "Vendor not found for booking", status: 400 };
        }

        const payoutAccount = await tx.vendorPayoutAccount.findUnique({
          where: { vendorId: vId },
        });

        if (!payoutAccount || !payoutAccount.isActive) {
          return { error: "Vendor payout account not found or inactive", status: 400 };
        }

        // Lock the row by marking it "processing" to prevent concurrent requests
        await tx.payment.update({
          where: { id: p.id },
          data: { vendorPayoutStatus: "processing" },
        });

        return { payment: p, vendorId: vId };
      });

      if (txResult.error) {
        return res.status(txResult.status).json({ message: txResult.error });
      }

      payment = txResult.payment;
      vendorId = txResult.vendorId;
    } catch (txError) {
      console.error("Transaction error:", txError);
      return res.status(500).json({ message: "Vendor payout failed", error: txError.message });
    }

    /**
     * Step 2: Initiate external payout (outside transaction to avoid long-held locks)
     */
    const payoutResult = await initiateVendorPayout(payment, vendorId);

    if (!payoutResult.success) {
      // Rollback status to "pending" so it can be retried
      await prisma.payment.update({
        where: { id: payment.id },
        data: { vendorPayoutStatus: "pending" },
      });

      return res.status(500).json({
        message: "Vendor payout failed",
        error: payoutResult.error,
      });
    }

    /**
     * Step 3: Mark payout as "paid" with the external payout ID
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
