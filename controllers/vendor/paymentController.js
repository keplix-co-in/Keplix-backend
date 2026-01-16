import Razorpay from 'razorpay';
import Stripe from 'stripe';

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder'
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// @desc    Create Vendor Payment Order (Subscription/Ads)
// @route   POST /service_api/vendor/payments/order/create
export const createVendorPaymentOrder = async (req, res) => {
    try {
        const { amount, currency = "INR", gateway } = req.body;

        if (!amount) {
            return res.status(400).json({ message: "Amount is required" });
        }

        if (gateway === 'stripe') {
            const paymentIntent = await stripe.paymentIntents.create({
                amount: Math.round(amount * 100),
                currency: currency.toLowerCase(),
                automatic_payment_methods: { enabled: true },
                metadata: { type: 'vendor_payment' }
            });

            return res.json({
                id: paymentIntent.id,
                clientSecret: paymentIntent.client_secret,
                gateway: 'stripe'
            });

        } else {
            const options = {
                amount: Math.round(amount * 100),
                currency: currency,
                receipt: "vendor_order_" + Date.now(),
            };

            const order = await razorpay.orders.create(options);

            return res.json({
                id: order.id,
                amount: order.amount,
                currency: order.currency,
                gateway: 'razorpay',
                key_id: process.env.RAZORPAY_KEY_ID
            });
        }
    } catch (error) {
        console.error("Vendor Payment Order Error:", error);
        res.status(500).json({ message: "Payment creation failed", error: error.message });
    }
};

// @desc    Verify Vendor Payment
// @route   POST /service_api/vendor/payments/verify
export const verifyVendorPayment = async (req, res) => {
    // Implement signature verification here if needed for DB Storage
    res.json({ status: "success", message: "Vendor payment verified" });
};

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
