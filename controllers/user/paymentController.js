// import Razorpay from 'razorpay';
// import Stripe from 'stripe';
// import { PrismaClient } from "@prisma/client";

// const prisma = new PrismaClient();

// const razorpay = new Razorpay({
//     key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
//     key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder'
// });

// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// // @desc    Create Payment Order
// // @route   POST /service_api/payments/order/create/
// export const createPaymentOrder = async (req, res) => {
//     try {
//         const { amount, currency = "INR", gateway } = req.body;

//         if (!amount) {
//             return res.status(400).json({ message: "Amount is required" });
//         }

//         if (gateway === 'stripe') {
//             // Stripe Payment Intent
//             const paymentIntent = await stripe.paymentIntents.create({
//                 amount: Math.round(amount * 100), // Stripe expects smallest currency unit
//                 currency: currency.toLowerCase(),
//                 automatic_payment_methods: {
//                     enabled: true,
//                 },
//             });

//             return res.json({
//                 id: paymentIntent.id,
//                 clientSecret: paymentIntent.client_secret,
//                 gateway: 'stripe'
//             });

//         } else {
//             // Default to Razorpay
//             const options = {
//                 amount: Math.round(amount * 100), // Razorpay also expects paise
//                 currency: currency,
//                 receipt: "order_" + Date.now(),
//             };

//             const order = await razorpay.orders.create(options);

//             console.log('✅ [Razorpay] Order created successfully:', {
//                 orderId: order.id,
//                 amount: order.amount,
//                 currency: order.currency,
//                 receipt: order.receipt,
//                 status: order.status
//             });

//             return res.json({
//                 id: order.id,
//                 amount: order.amount,
//                 currency: order.currency,
//                 gateway: 'razorpay',
//                 key_id: process.env.RAZORPAY_KEY_ID,
//                 receipt: order.receipt,
//                 status: order.status
//             });
//         }
//     } catch (error) {
//         console.error("Payment Order Error:", error);
//         res.status(500).json({ message: "Payment creation failed", error: error.message });
//     }
// };

// // @desc    Verify and Save Payment
// // @route   POST /service_api/payments/verify/
// export const verifyPayment = async (req, res) => {
//     try {
//         const { id, amount, currency, gateway, status, paymentId, signature, bookingId } = req.body;
        
//         // id = order ID (from create response)
//         // paymentId = actual payment ID (if payment was completed)
//         const orderId = id;
//         const transactionId = paymentId || id; // Use paymentId if available, otherwise orderId

//         console.log('[Payment Verify] Request received:', {
//             orderId: id,
//             paymentId,
//             bookingId,
//             gateway,
//             amount,
//             status
//         });

//         // For testing: bookingId is optional
//         // In production, you should require it

//         // 1. Verify Signature (Skipped for demo - assume secure if gateway confirms)
//         // In prod, use razorpay.utils.verifyPaymentSignature or Stripe Webhooks

//         // 2. Save to DB
//         // Calculate Platform Fee (e.g., 10%)
//         const totalAmount = parseFloat(amount || 0); 
//         const platformFee = totalAmount * 0.10; 
//         const vendorAmount = totalAmount - platformFee;

//         const paymentData = {
//             amount: totalAmount,
//             currency: currency || 'INR',
//             method: gateway || 'unknown',
//             transactionId: transactionId,
//             status: paymentId ? 'success' : 'pending', // Success if paymentId provided, otherwise pending
//             vendorPayoutStatus: 'pending', // Waiting for service completion
//             platformFee: platformFee,
//             vendorAmount: vendorAmount
//         };

//         // Only link to booking if bookingId is provided
//         if (bookingId) {
//             paymentData.bookingId = parseInt(bookingId);
//         }

//         const payment = await prisma.payment.create({
//             data: paymentData
//         });

//         console.log('✅ [Payment Verify] Payment saved to database:', {
//             paymentId: payment.id,
//             amount: payment.amount,
//             status: payment.status,
//             transactionId: payment.transactionId
//         });

//         // 3. Update Booking Status to Confirmed (if bookingId provided)
//         if (bookingId) {
//             try {
//                 await prisma.booking.update({
//                     where: { id: parseInt(bookingId) },
//                     data: { status: 'confirmed' }
//                 });
//                 console.log('✅ [Payment Verify] Booking status updated to confirmed');
//             } catch (bookingError) {
//                 console.warn('⚠️  [Payment Verify] Could not update booking:', bookingError.message);
//             }
//         }

//         res.json({ 
//             status: "success", 
//             message: bookingId 
//                 ? "Payment verified and held in Escrow" 
//                 : "Payment verified (test mode - no booking linked)", 
//             paymentId: payment.id,
//             amount: payment.amount,
//             platformFee: payment.platformFee,
//             vendorAmount: payment.vendorAmount
//         });

//     } catch (error) {
//         console.error("Payment Verification Error:", error);
//         res.status(500).json({ 
//             message: "Payment verification failed",
//             error: error.message 
//         });
//     }
// };

// // @desc    Get User Payments
// // @route   GET /service_api/user/:user_id/payments/
// export const getUserPayments = async (req, res) => {
//     res.json([]); // Return empty list for now
// };

import Razorpay from "razorpay";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { verifyRazorpayWebhook } from "../../util/webhookVerification.js";
import Logger from "../../util/logger.js";

const prisma = new PrismaClient();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * CREATE PAYMENT ORDER
 * User -> Keplix
 */
export const createPaymentOrder = async (req, res) => {
  try {
    const { amount, currency = "INR", gateway } = req.body;

    if (!amount) {
      return res.status(400).json({ message: "Amount is required" });
    }
    

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency,
      receipt: `order_${Date.now()}`,
    });

    const responseData = {
      id: order.id || order.orderId, // This must be present and a string!
      orderId: order.id, 
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID, 
      key: process.env.RAZORPAY_KEY_ID, 
      gateway: 'razorpay'
    };

    console.log('✅ [Razorpay] Order created:', responseData);

    return res.json(responseData);
  } catch (error) {
    console.error("Create payment order error:", error);
    res.status(500).json({ message: "Payment order failed", error: error.message });
  }
};

/**
 * VERIFY PAYMENT
 * Payment verify + commission calculation
 */
export const verifyPayment = async (req, res) => {
  try {
    const {
      orderId,
      paymentId,
      signature,
      bookingId,
      amount,
      gateway
    } = req.body;

    // Verify Razorpay
    const body = orderId + "|" + paymentId;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");
      //console.log(expectedSignature, signature)

    if (expectedSignature !== signature) {
        return res.status(400).json({ message: "Invalid payment signature" });
    }
    // Verified Razorpay

    // Commission calculation
    const totalAmount = Number(amount);
    const platformFee = totalAmount * 0.1; // 10%
    const vendorAmount = totalAmount - platformFee;

    // Save payment
    const paymentData = {
      amount: totalAmount,
      currency: "INR",
      status: "success",
      method: "razorpay",
      transactionId: paymentId,
      platformFee,
      vendorAmount,
      vendorPayoutStatus: "pending",
    };

    let payment;
    if (bookingId) {
      payment = await prisma.payment.upsert({
        where: { bookingId: Number(bookingId) },
        update: paymentData,
        create: {
          bookingId: Number(bookingId),
          ...paymentData,
        },
      });
    } else {
      payment = await prisma.payment.create({
        data: paymentData,
      });
    }

    // Update booking
    if (bookingId) {
      await prisma.booking.update({
        where: { id: Number(bookingId) },
        data: { status: "confirmed" },
      });
    }

    res.json({
      success: true,
      paymentId: payment.id,
      platformFee,
      vendorAmount,
      message: "Payment verified, payout pending",
    });
  } catch (error) {
    console.error("Verify payment error:", error);
    res.status(500).json({ message: "Payment verification failed" });
  }
};

/**
 * RAZORPAY WEBHOOK HANDLER
 * Handles payment status updates from Razorpay
 */
export const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
      Logger.error('[Webhook] RAZORPAY_WEBHOOK_SECRET not configured');
      return res.status(500).json({ error: 'Webhook not configured' });
    }

    // Verify webhook signature
    const isValid = verifyRazorpayWebhook(req, webhookSecret);
    
    if (!isValid) {
      Logger.error('[Webhook] Invalid signature - possible security breach');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const { event, payload } = req.body;
    Logger.info(`[Webhook] Received event: ${event}`);

    // Handle different payment events
    switch (event) {
      case 'payment.captured':
        await handlePaymentCaptured(payload.payment.entity);
        break;
        
      case 'payment.failed':
        await handlePaymentFailed(payload.payment.entity);
        break;
        
      case 'order.paid':
        Logger.info(`[Webhook] Order paid: ${payload.order.entity.id}`);
        break;
        
      default:
        Logger.info(`[Webhook] Unhandled event type: ${event}`);
    }

    res.json({ received: true });
  } catch (error) {
    Logger.error(`[Webhook] Error: ${error.message}`);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

// Helper: Handle payment captured event
async function handlePaymentCaptured(payment) {
  try {
    const { id, order_id, amount, status } = payment;
    
    Logger.info(`[Webhook] Payment captured: ${id}, Amount: ${amount / 100}`);
    
    // Update payment record if exists
    const existingPayment = await prisma.payment.findFirst({
      where: { transactionId: id }
    });

    if (existingPayment) {
      await prisma.payment.update({
        where: { id: existingPayment.id },
        data: { status: 'success' }
      });
      Logger.info(`[Webhook] Payment ${id} updated to success`);
    }
  } catch (error) {
    Logger.error(`[Webhook] handlePaymentCaptured error: ${error.message}`);
  }
}

// Helper: Handle payment failed event
async function handlePaymentFailed(payment) {
  try {
    const { id, error_description } = payment;
    
    Logger.error(`[Webhook] Payment failed: ${id}, Reason: ${error_description}`);
    
    const existingPayment = await prisma.payment.findFirst({
      where: { transactionId: id }
    });

    if (existingPayment) {
      await prisma.payment.update({
        where: { id: existingPayment.id },
        data: { status: 'failed' }
      });
      
      // Update booking back to pending
      if (existingPayment.bookingId) {
        await prisma.booking.update({
          where: { id: existingPayment.bookingId },
          data: { status: 'pending' }
        });
      }
    }
  } catch (error) {
    Logger.error(`[Webhook] handlePaymentFailed error: ${error.message}`);
  }
}

