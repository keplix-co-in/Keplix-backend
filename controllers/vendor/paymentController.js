// import Razorpay from 'razorpay';
// import Stripe from 'stripe';

// const razorpay = new Razorpay({
//     key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
//     key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder'
// });

// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// // @desc    Create Vendor Payment Order (Subscription/Ads)
// // @route   POST /service_api/vendor/payments/order/create
// export const createVendorPaymentOrder = async (req, res) => {
//     try {
//         const { amount, currency = "INR", gateway } = req.body;

//         if (!amount) {
//             return res.status(400).json({ message: "Amount is required" });
//         }

//         if (gateway === 'stripe') {
//             const paymentIntent = await stripe.paymentIntents.create({
//                 amount: Math.round(amount * 100),
//                 currency: currency.toLowerCase(),
//                 automatic_payment_methods: { enabled: true },
//                 metadata: { type: 'vendor_payment' }
//             });

//             return res.json({
//                 id: paymentIntent.id,
//                 clientSecret: paymentIntent.client_secret,
//                 gateway: 'stripe'
//             });

//         } else {
//             const options = {
//                 amount: Math.round(amount * 100),
//                 currency: currency,
//                 receipt: "vendor_order_" + Date.now(),
//             };

//             const order = await razorpay.orders.create(options);

//             return res.json({
//                 id: order.id,
//                 amount: order.amount,
//                 currency: order.currency,
//                 gateway: 'razorpay',
//                 key_id: process.env.RAZORPAY_KEY_ID
//             });
//         }
//     } catch (error) {
//         console.error("Vendor Payment Order Error:", error);
//         res.status(500).json({ message: "Payment creation failed", error: error.message });
//     }
// };

// // @desc    Verify Vendor Payment
// // @route   POST /service_api/vendor/payments/verify
// export const verifyVendorPayment = async (req, res) => {
//     // Implement signature verification here if needed for DB Storage
//     res.json({ status: "success", message: "Vendor payment verified" });
// };

// // @desc    Get Vendor Payments/Earnings
// // @route   GET /service_api/vendor/:vendor_id/payments/
// export const getVendorPayments = async (req, res) => {
//     res.json([]);
// };

// // @desc    Get Vendor Earnings
// // @route   GET /service_api/vendor/:vendor_id/earning
// export const getVendorEarnings = async (req, res) => {
//     // Mock response for now
//     res.json({
//         today_earnings: 0,
//         total_earnings: 0,
//         growth_percentage: 0
//     });
// };

import Razorpay from "razorpay";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_placeholder",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "secret_placeholder",
});


/**
 * @desc    Create Vendor Payment Order (Subscription / Ads / Promotion)
 * @route   POST /service_api/vendor/payments/order/create
 * Vendor → Keplix
 */
export const createVendorPaymentOrder = async (req, res) => {
  try {
    const { amount, currency = "INR", gateway } = req.body;

    if (!amount) {
      return res.status(400).json({ message: "Amount is required" });
    }

    // STRIPE
    if (gateway === "stripe") {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: {
          type: "vendor_payment",
          vendorId: req.user.id,
        },
      });

      return res.json({
        id: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        gateway: "stripe",
      });
    }

    // RAZORPAY (default)
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency,
      receipt: `vendor_order_${Date.now()}`,
      notes: {
        vendorId: req.user.id,
        type: "vendor_payment",
      },
    });

    return res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      gateway: "razorpay",
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Vendor Payment Order Error:", error);
    res.status(500).json({
      message: "Vendor payment order creation failed",
      error: error.message,
    });
  }
};

/**
 * @desc    Verify Vendor Payment
 * @route   POST /service_api/vendor/payments/verify
 */
export const verifyVendorPayment = async (req, res) => {
  try {
    const {
      orderId,
      paymentId,
      signature,
      amount,
      currency = "INR",
      gateway,
    } = req.body;

    // ---------------- RAZORPAY VERIFY ----------------
    if (gateway === "razorpay") {
      const body = orderId + "|" + paymentId;
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest("hex");

      if (expectedSignature !== signature) {
        return res.status(400).json({ message: "Invalid Razorpay signature" });
      }
    }

    // ---------------- SAVE PAYMENT ----------------
    
    await prisma.payment.create({
      data: {
        amount: Number(amount),
        currency,
        status: "success",
        method: gateway,
        transactionId: paymentId,
        vendorPayoutStatus: "not_applicable", // IMPORTANT
        platformFee: Number(amount), // full amount is Keplix earning
        vendorAmount: 0,
      },
    });

    res.json({
      success: true,
      message: "Vendor payment verified successfully",
    });
  } catch (error) {
    console.error("Vendor Payment Verify Error:", error);
    res.status(500).json({
      message: "Vendor payment verification failed",
      error: error.message,
    });
  }
};

/**
 * @desc    Get Vendor Payments (what vendor paid to Keplix)
 * @route   GET /service_api/vendor/:vendor_id/payments
 */
export const getVendorPayments = async (req, res) => {
  try {
    const vendorId = Number(req.params.vendor_id);

    const payments = await prisma.payment.findMany({
      where: {
        method: { in: ["razorpay", "stripe"] },
        vendorPayoutStatus: "not_applicable",
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(payments);
  } catch (error) {
    console.error("Get vendor payments error:", error);
    res.status(500).json({ message: "Failed to fetch vendor payments" });
  }
};

/**
 * @desc    Get Vendor Earnings (from user bookings)
 * @route   GET /service_api/vendor/:vendor_id/earning
 */
export const getVendorEarnings = async (req, res) => {
  try {
    const vendorId = Number(req.params.vendor_id);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const payments = await prisma.payment.findMany({
      where: {
        status: "success", // Count all successful payments
        booking: {
          service: {
            vendorId, 
          },
        },
      },
      select: {
          amount: true,
          vendorAmount: true,
          createdAt: true
      }
    });

    const total_earnings = payments.reduce(
      (sum, p) => sum + Number(p.vendorAmount || p.amount || 0),
      0
    );

    const today_earnings = payments
        .filter(p => new Date(p.createdAt) >= today)
        .reduce((sum, p) => sum + Number(p.vendorAmount || p.amount || 0), 0);

    res.json({
      today_earnings,
      total_earnings,
      growth_percentage: 12.5, // Dummy growth for now
    });
  } catch (error) {
    console.error("Vendor earnings error:", error);
    res.status(500).json({ message: "Failed to fetch vendor earnings" });
  }
};
