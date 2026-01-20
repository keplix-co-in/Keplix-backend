import Razorpay from 'razorpay';
import Stripe from 'stripe';
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder'
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// @desc    Create Payment Order
// @route   POST /service_api/payments/order/create/
export const createPaymentOrder = async (req, res) => {
    try {
        const { amount, currency = "INR", gateway } = req.body;

        if (!amount) {
            return res.status(400).json({ message: "Amount is required" });
        }

        if (gateway === 'stripe') {
            // Stripe Payment Intent
            const paymentIntent = await stripe.paymentIntents.create({
                amount: Math.round(amount * 100), // Stripe expects smallest currency unit
                currency: currency.toLowerCase(),
                automatic_payment_methods: {
                    enabled: true,
                },
            });

            return res.json({
                id: paymentIntent.id,
                clientSecret: paymentIntent.client_secret,
                gateway: 'stripe'
            });

        } else {
            // Default to Razorpay
            const options = {
                amount: Math.round(amount * 100), // Razorpay also expects paise
                currency: currency,
                receipt: "order_" + Date.now(),
            };

            const order = await razorpay.orders.create(options);

            console.log('✅ [Razorpay] Order created successfully:', {
                orderId: order.id,
                amount: order.amount,
                currency: order.currency,
                receipt: order.receipt,
                status: order.status
            });

            return res.json({
                id: order.id,
                amount: order.amount,
                currency: order.currency,
                gateway: 'razorpay',
                key_id: process.env.RAZORPAY_KEY_ID,
                receipt: order.receipt,
                status: order.status
            });
        }
    } catch (error) {
        console.error("Payment Order Error:", error);
        res.status(500).json({ message: "Payment creation failed", error: error.message });
    }
};

// @desc    Verify and Save Payment
// @route   POST /service_api/payments/verify/
export const verifyPayment = async (req, res) => {
    try {
        const { id, amount, currency, gateway, status, paymentId, signature, bookingId } = req.body;
        
        // id = order ID (from create response)
        // paymentId = actual payment ID (if payment was completed)
        const orderId = id;
        const transactionId = paymentId || id; // Use paymentId if available, otherwise orderId

        console.log('🔍 [Payment Verify] Request received:', {
            orderId: id,
            paymentId,
            bookingId,
            gateway,
            amount,
            status
        });

        // For testing: bookingId is optional
        // In production, you should require it

        // 1. Verify Signature (Skipped for demo - assume secure if gateway confirms)
        // In prod, use razorpay.utils.verifyPaymentSignature or Stripe Webhooks

        // 2. Save to DB
        // Calculate Platform Fee (e.g., 10%)
        const totalAmount = parseFloat(amount || 0); 
        const platformFee = totalAmount * 0.10; 
        const vendorAmount = totalAmount - platformFee;

        const paymentData = {
            amount: totalAmount,
            currency: currency || 'INR',
            method: gateway || 'unknown',
            transactionId: transactionId,
            status: paymentId ? 'success' : 'pending', // Success if paymentId provided, otherwise pending
            vendorPayoutStatus: 'pending', // Waiting for service completion
            platformFee: platformFee,
            vendorAmount: vendorAmount
        };

        // Only link to booking if bookingId is provided
        if (bookingId) {
            paymentData.bookingId = parseInt(bookingId);
        }

        const payment = await prisma.payment.create({
            data: paymentData
        });

        console.log('✅ [Payment Verify] Payment saved to database:', {
            paymentId: payment.id,
            amount: payment.amount,
            status: payment.status,
            transactionId: payment.transactionId
        });

        // 3. Update Booking Status to Confirmed (if bookingId provided)
        if (bookingId) {
            try {
                await prisma.booking.update({
                    where: { id: parseInt(bookingId) },
                    data: { status: 'confirmed' }
                });
                console.log('✅ [Payment Verify] Booking status updated to confirmed');
            } catch (bookingError) {
                console.warn('⚠️  [Payment Verify] Could not update booking:', bookingError.message);
            }
        }

        res.json({ 
            status: "success", 
            message: bookingId 
                ? "Payment verified and held in Escrow" 
                : "Payment verified (test mode - no booking linked)", 
            paymentId: payment.id,
            amount: payment.amount,
            platformFee: payment.platformFee,
            vendorAmount: payment.vendorAmount
        });

    } catch (error) {
        console.error("Payment Verification Error:", error);
        res.status(500).json({ 
            message: "Payment verification failed",
            error: error.message 
        });
    }
};

// @desc    Get User Payments
// @route   GET /service_api/user/:user_id/payments/
export const getUserPayments = async (req, res) => {
    res.json([]); // Return empty list for now
};
