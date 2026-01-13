// @desc    Create Payment Order (Stub)
// @route   POST /service_api/payments/order/create/
export const createPaymentOrder = async (req, res) => {
    // Return a fake order ID so frontend proceeds
    res.json({
        id: "order_fake_" + Date.now(),
        amount: req.body.amount,
        currency: "INR"
    });
};

// @desc    Verify Payment
// @route   POST /service_api/payments/verify/
export const verifyPayment = async (req, res) => {
    res.json({ status: "success", message: "Payment verified successfully" });
};

// @desc    Get User Payments
// @route   GET /service_api/user/:user_id/payments/
export const getUserPayments = async (req, res) => {
    res.json([]); // Return empty list for now
};
