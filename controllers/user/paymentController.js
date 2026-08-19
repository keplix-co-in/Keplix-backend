<<<<<<< HEAD
﻿// import Razorpay from 'razorpay';
// import Stripe from 'stripe';
// import prisma from "../../util/prisma.js";

// 

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

//             console.log('âœ… [Razorpay] Order created successfully:', {
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

//         console.log('âœ… [Payment Verify] Payment saved to database:', {
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
//                 console.log('âœ… [Payment Verify] Booking status updated to confirmed');
//             } catch (bookingError) {
//                 console.warn('âš ï¸  [Payment Verify] Could not update booking:', bookingError.message);
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
=======
import Razorpay from "razorpay";
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
import prisma from "../../util/prisma.js";
import { verifyRazorpayWebhook } from "../../util/webhookVerification.js";
import { createNotification } from "../../util/notificationHelper.js";
import Logger from "../../util/logger.js";
<<<<<<< HEAD
=======
import { verifyAndRecordPayment, recordCapturedPaymentFromWebhook, PaymentError } from "../../services/paymentService.js";
import { resolveBookingAmount } from "../../util/servicePricing.js";
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d



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
<<<<<<< HEAD
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
=======
    // `amount` is intentionally ignored — the client used to be able to
    // request an order for any amount it liked (e.g. ₹1 against a ₹5,000
    // booking), and verification never cross-checked it against the booking
    // price, so a valid signature on a cheap order recorded a full-price
    // payment. The price is now looked up server-side from the booking.
    const { currency = "INR", bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID is required" });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
      include: { service: true, bookingVehicle: true },
    });

    if (!booking || !booking.service) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Not authorized for this booking" });
    }

    // Prefers BookingVehicle.price_snapshot (segment price at the time this
    // booking was created) over a fresh lookup of the service's current
    // price. See util/servicePricing.js — this is one of three sites that
    // must agree, or the webhook's cross-check below fails every payment.
    const amount = resolveBookingAmount(booking);

    const receipt = `rcpt_bk_${bookingId}`;

    // Idempotency by receipt lookup rather than the X-Razorpay-Idempotency-Key
    // header. razorpay@2.9.6's orders.create(params, cb) takes a CALLBACK as
    // its second argument, not headers — passing a headers object there made
    // the SDK invoke it as a function and every single order creation died
    // with "cb is not a function", so no payment could ever start. The SDK's
    // api.post has no per-request header support at all (headers are fixed at
    // client construction), so the key cannot be sent this way.
    //
    // The receipt is already unique per booking, so an unpaid order for this
    // booking is reused instead of piling up duplicates — which matters
    // because the app can fire this endpoint twice for one tap.
    let order = null;
    try {
      const existing = await razorpay.orders.all({ receipt, count: 10 });
      order = (existing?.items ?? []).find(
        (o) => o.status === 'created' && Number(o.amount) === Math.round(amount * 100)
      ) ?? null;
    } catch (lookupError) {
      // A failed lookup must not block payment — worst case we create a new
      // order, which is the pre-existing behaviour anyway.
      console.warn('Order idempotency lookup failed, creating a new order:', lookupError.message);
    }

    if (!order) {
      order = await razorpay.orders.create({
        amount: Math.round(amount * 100),
        currency,
        receipt,
        // The webhook handler needs a reliable way to resolve which booking a
        // captured payment belongs to when it's creating the payment record
        // itself (client died before calling /verify) — notes are echoed back
        // on both the order and payment webhook entities, unlike `receipt`
        // parsing which is a string convention rather than a real contract.
        notes: { bookingId: String(bookingId) },
      });
    }

    const finalOrderId = order.id || order.orderId;

    const responseData = {
      id: finalOrderId, // This must be present and a string!
      orderId: finalOrderId, 
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID, 
      key: process.env.RAZORPAY_KEY_ID, 
      gateway: 'razorpay'
    };

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
<<<<<<< HEAD
    const {
      orderId,
      paymentId,
      signature,
      bookingId,
      amount,
      gateway
    } = req.body;

    // Verify Razorpay or Skip for Cash/Demo
    // Also skip if signature is explicitly a mock one (for dev mode)
    if (gateway !== 'cash' && gateway !== 'card' && gateway !== 'upi' && gateway !== 'netbanking' && !signature.startsWith('mock_')) {
      const body = orderId + "|" + paymentId;
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest("hex");
        //console.log(expectedSignature, signature)

      if (expectedSignature !== signature) {
          return res.status(400).json({ message: "Invalid payment signature" });
      }
    }
    // Verified

    // Commission calculation
    const totalAmount = Number(amount);
    const platformFee = totalAmount * 0.1; // 10%
    const vendorAmount = totalAmount - platformFee;

    // Save payment
    const paymentData = {
      amount: totalAmount,
      currency: "INR",
      status: "success",
      method: gateway || "razorpay", // Use provided gateway method
      transactionId: paymentId || `TXN${Date.now()}`,
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
      const updatedBooking = await prisma.booking.update({
        where: { id: Number(bookingId) },
        data: { status: "confirmed" },
        include: { service: true }
      });

      // Notify Vendor about successful payment
      if (updatedBooking.service && updatedBooking.service.vendorId) {
        await createNotification(
          updatedBooking.service.vendorId,
          "ðŸ’° New Payment Received!",
          `A user has paid for ${updatedBooking.service.name}. You can now start the service.`,
          { type: 'PAYMENT_RECEIVED', bookingId: updatedBooking.id }
        );

        // Notify vendor via socket
        const io = req.app.get("io");
        if (io) {
          io.to(`user_${updatedBooking.service.vendorId}`).emit("payment_received", {
            bookingId: updatedBooking.id,
            service: updatedBooking.service.name,
            amount: payment.amount,
            message: "Payment received! You can now start the service."
          });
        }
      }
    }
=======
    const { orderId, paymentId, signature, bookingId, gateway } = req.body;

    const { payment, updatedBooking, platformFee, vendorAmount } = await verifyAndRecordPayment({
      bookingId,
      requestingUserId: req.user.id,
      orderId,
      paymentId,
      signature,
      gateway,
    });

    // Notify Vendor about successful payment
    if (updatedBooking) {
      if (updatedBooking.service && updatedBooking.service.vendorId) {
        await createNotification(
          updatedBooking.service.vendorId,
          "ðŸ’° New Payment Received!",
          `A user has paid for ${updatedBooking.service.name}. You can now start the service.`,
          { type: 'PAYMENT_RECEIVED', bookingId: updatedBooking.id }
        );

        // Notify vendor via socket
        const io = req.app.get("io");
        if (io) {
          io.to(`user_${updatedBooking.service.vendorId}`).emit("payment_received", {
            bookingId: updatedBooking.id,
            service: updatedBooking.service.name,
            amount: payment.amount,
            message: "Payment received! You can now start the service."
          });
        }
      }
    }
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d

    res.json({
      success: true,
      paymentId: payment.id,
      platformFee,
      vendorAmount,
      message: "Payment verified, payout pending",
    });
  } catch (error) {
    console.error("Verify payment error:", error);
<<<<<<< HEAD
=======
    if (error instanceof PaymentError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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
<<<<<<< HEAD
    
    if (!webhookSecret) {
      Logger.error('[Webhook] RAZORPAY_WEBHOOK_SECRET not configured');
=======

    // The .env.example placeholder value is truthy, so a deployment that never
    // set a real secret would otherwise sail past the `!webhookSecret` check
    // and verify every webhook against a value nobody else could ever produce
    // a valid HMAC for — meaning every real webhook silently fails forever.
    if (!webhookSecret || webhookSecret === 'your_razorpay_webhook_secret_here') {
      Logger.error('[Webhook] RAZORPAY_WEBHOOK_SECRET not configured (missing or placeholder)');
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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

<<<<<<< HEAD
=======
    // Dedupe/replay protection. Razorpay retries webhook delivery on
    // timeout/non-2xx, and a captured valid webhook body+signature is
    // otherwise replayable indefinitely (nothing about the signature check
    // is single-use). eventId prefers Razorpay's own delivery id header;
    // when absent, a deterministic key derived from the event contents is
    // used instead so the same underlying event still collapses to one row.
    // refund.entity is included deliberately: without it every refund event
    // falls through to 'unknown', so two unrelated refunds delivered in the
    // same second would generate the same fallback eventId and the second
    // would be silently discarded as a duplicate.
    const entityId =
      payload?.payment?.entity?.id ||
      payload?.refund?.entity?.id ||
      payload?.order?.entity?.id ||
      'unknown';
    const eventId = req.headers['x-razorpay-event-id']
      || `${event}:${entityId}:${req.body?.created_at || ''}`;

    try {
      await prisma.webhookEvent.create({
        data: { eventId: String(eventId), eventType: String(event) },
      });
    } catch (dedupeErr) {
      if (dedupeErr?.code === 'P2002') {
        Logger.info(`[Webhook] Duplicate delivery ignored: ${eventId}`);
        return res.json({ received: true, duplicate: true });
      }
      throw dedupeErr;
    }

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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
<<<<<<< HEAD
        
=======

      // Refund outcomes. issueRefund writes 'gateway_confirmed' the moment the
      // API call returns, but the refund is only actually settled later —
      // without these two the row would never reach the truth.
      case 'refund.processed':
        await handleRefundProcessed(payload.refund.entity);
        break;

      case 'refund.failed':
        await handleRefundFailed(payload.refund.entity);
        break;


>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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
<<<<<<< HEAD
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
=======
    const { id, order_id, amount, notes } = payment;

    Logger.info(`[Webhook] Payment captured: ${id}, Amount: ${amount / 100}`);

    // If /verify already ran, this just flips status to success (or is a
    // no-op if it's already there). If the client died before calling
    // /verify at all, this is the only place that payment ever gets
    // recorded — so it has to be able to create the row, not just update one
    // that may not exist yet.
    const result = await recordCapturedPaymentFromWebhook({
      orderId: order_id,
      paymentId: id,
      amountPaise: amount,
      bookingIdHint: notes?.bookingId,
    });

    if (result.mismatch) {
      Logger.error(`[Webhook] Payment ${id} captured amount does not match booking price — needs manual review`);
    } else if (result.unresolved) {
      Logger.error(`[Webhook] Payment ${id} could not be matched to a booking — needs manual review`);
    } else if (result.created) {
      Logger.info(`[Webhook] Payment ${id} created and booking confirmed from webhook (client never called /verify)`);
    } else {
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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

<<<<<<< HEAD
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
=======
    // A late payment.failed delivery must not revert a payment that has
    // already succeeded and possibly been paid out to the vendor — webhook
    // events aren't guaranteed to arrive in order, and Razorpay can retry
    // deliveries, so a stale "failed" for an already-captured payment is a
    // realistic case, not a hypothetical one.
    if (existingPayment && existingPayment.status !== 'success') {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: existingPayment.id },
          data: { status: 'failed' }
        });

        // Update booking back to pending
        if (existingPayment.bookingId) {
          await tx.booking.update({
            where: { id: existingPayment.bookingId },
            data: { status: 'pending' }
          });
        }
      });
      Logger.info(`[Webhook] Payment ${id} updated to failed and booking reverted to pending`);
    } else if (existingPayment) {
      Logger.warn(`[Webhook] Ignored stale payment.failed for already-successful payment ${id}`);
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    }
  } catch (error) {
    Logger.error(`[Webhook] handlePaymentFailed error: ${error.message}`);
  }
}

<<<<<<< HEAD
=======
// Helper: Handle refund processed event
//
// issueRefund optimistically marks a row 'processed' once its own bookkeeping
// succeeds, but the gateway is the authority on whether the money actually
// reached the customer. This is the confirmation.
async function handleRefundProcessed(refundEntity) {
  try {
    const { id, payment_id } = refundEntity;

    const refund = await prisma.refund.findFirst({ where: { gatewayRefundId: id } });

    if (!refund) {
      // A refund we have no record of — issued directly from the Razorpay
      // dashboard, most likely. Worth knowing about: our Payment row still
      // says the money is ours.
      Logger.warn(
        `[Webhook] refund.processed for unknown refund ${id} (payment ${payment_id}) — ` +
        `possibly issued outside the app.`
      );
      return;
    }

    if (refund.status === 'processed') {
      Logger.info(`[Webhook] Refund ${id} already processed, ignoring duplicate`);
      return;
    }

    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'processed', gatewayResponse: JSON.stringify(refundEntity) },
    });

    Logger.info(`[Webhook] Refund ${id} confirmed processed`);
  } catch (error) {
    Logger.error(`[Webhook] handleRefundProcessed error: ${error.message}`);
  }
}

// Helper: Handle refund failed event
//
// The money did NOT reach the customer. Marked gateway_failed, which is the
// one status refundService will let a retry re-reserve — deliberately, because
// there the funds provably did not move.
async function handleRefundFailed(refundEntity) {
  try {
    const { id, payment_id } = refundEntity;

    const refund = await prisma.refund.findFirst({ where: { gatewayRefundId: id } });

    if (!refund) {
      Logger.warn(`[Webhook] refund.failed for unknown refund ${id} (payment ${payment_id})`);
      return;
    }

    // Never walk back a refund the gateway already confirmed as processed —
    // deliveries can arrive out of order, and marking a completed refund as
    // failed would invite a second one.
    if (refund.status === 'processed') {
      Logger.warn(`[Webhook] Ignored stale refund.failed for already-processed refund ${id}`);
      return;
    }

    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: 'gateway_failed',
        lastError: refundEntity?.error_description || 'Gateway reported refund failure',
        gatewayResponse: JSON.stringify(refundEntity),
      },
    });

    Logger.error(`[MANUAL ACTION] Refund ${id} failed at the gateway — customer has NOT been refunded.`);
  } catch (error) {
    Logger.error(`[Webhook] handleRefundFailed error: ${error.message}`);
  }
}

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d


