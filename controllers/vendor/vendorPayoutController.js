import { triggerVendorPayoutNow, VendorPayoutError } from "../../services/vendorPayoutService.js";

/**
 * @desc    Trigger Vendor Payout
 * @route   POST /service_api/admin/vendor/payout
 * @access  Admin / System
 */
export const triggerVendorPayout = async (req, res) => {
  try {
    const { paymentId } = req.body;

    const { payoutId, amount } = await triggerVendorPayoutNow(paymentId);

    res.json({
      success: true,
      message: "Vendor payout successful",
      payoutId,
      amount,
    });
  } catch (error) {
    console.error("Vendor payout error:", error);
    if (error instanceof VendorPayoutError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    res.status(500).json({
      message: "Vendor payout failed",
      error: error.message,
    });
  }
};
