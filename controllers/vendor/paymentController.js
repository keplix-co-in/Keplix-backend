// @desc    Get Vendor Payments/Earnings
// @route   GET /service_api/vendor/:vendor_id/payments/
export const getVendorPayments = async (req, res) => {
    res.json([]);
};

// @desc    Get Vendor Earnings
// @route   GET /service_api/vendor/:vendor_id/earning
export const getVendorEarnings = async (req, res) => {
    // Mock response for now
    res.json({
        today_earnings: 0,
        total_earnings: 0,
        growth_percentage: 0
    });
};
