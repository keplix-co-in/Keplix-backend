import Razorpay from "razorpay";
import crypto from "crypto";
import prisma from "../../util/prisma.js";
import { verifyRazorpayWebhook } from "../../util/webhookVerification.js";
import { createNotification } from "../../util/notificationHelper.js";
import Logger from "../../util/logger.js";
import { verifyAndRecordPayment, recordCapturedPaymentFromWebhook, PaymentError } from "../../services/paymentService.js";



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
      include: { service: true },
    });

    if (!booking || !booking.service) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Not authorized for this booking" });
    }

    const amount = parseFloat(booking.service.price.toString());

    // Generate idempotency key using bookingId hash (MD5 used for 32-char length to fit Razorpay's 36-char limit)
    const idempotencyKey = crypto.createHash("md5").update(String(bookingId)).digest("hex");

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency,
      receipt: `rcpt_bk_${bookingId}`,
      // The webhook handler needs a reliable way to resolve which booking a
      // captured payment belongs to when it's creating the payment record
      // itself (client died before calling /verify) — notes are echoed back
      // on both the order and payment webhook entities, unlike `receipt`
      // parsing which is a string convention rather than a real contract.
      notes: { bookingId: String(bookingId) },
    }, {
      "X-Razorpay-Idempotency-Key": idempotencyKey
    });

    const finalOrderId = order.id || order.orderId;

    const responseData = {
      id: finalOrderId, // This must be present and a string!
      orderId: finalOrderId, 
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

    res.json({
      success: true,
      paymentId: payment.id,
      platformFee,
      vendorAmount,
      message: "Payment verified, payout pending",
    });
  } catch (error) {
    console.error("Verify payment error:", error);
    if (error instanceof PaymentError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
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

    // The .env.example placeholder value is truthy, so a deployment that never
    // set a real secret would otherwise sail past the `!webhookSecret` check
    // and verify every webhook against a value nobody else could ever produce
    // a valid HMAC for — meaning every real webhook silently fails forever.
    if (!webhookSecret || webhookSecret === 'your_razorpay_webhook_secret_here') {
      Logger.error('[Webhook] RAZORPAY_WEBHOOK_SECRET not configured (missing or placeholder)');
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

    // Dedupe/replay protection. Razorpay retries webhook delivery on
    // timeout/non-2xx, and a captured valid webhook body+signature is
    // otherwise replayable indefinitely (nothing about the signature check
    // is single-use). eventId prefers Razorpay's own delivery id header;
    // when absent, a deterministic key derived from the event contents is
    // used instead so the same underlying event still collapses to one row.
    const entityId = payload?.payment?.entity?.id || payload?.order?.entity?.id || 'unknown';
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
    }
  } catch (error) {
    Logger.error(`[Webhook] handlePaymentFailed error: ${error.message}`);
  }
}



