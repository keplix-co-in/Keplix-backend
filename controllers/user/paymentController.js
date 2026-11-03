import Razorpay from "razorpay";
import prisma from "../../util/prisma.js";
import { verifyRazorpayWebhook } from "../../util/webhookVerification.js";
import { createNotification } from "../../util/notificationHelper.js";
import { renderNotification, NOTIFICATION_TYPES } from "../../util/notificationTemplates.js";
import Logger from "../../util/logger.js";
import { verifyAndRecordPayment, recordCapturedPaymentFromWebhook, PaymentError } from "../../services/paymentService.js";
import { resolveBookingAmount } from "../../util/servicePricing.js";
import { isBookingPayable } from "../../util/bookingStatus.js";
import { parseIdParam } from "../../util/parseIdParam.js";
import { describeGatewayError } from "../../util/razorpayCredentials.js";
import { applyGatewayRefundOutcome, recordDashboardRefund } from "../../services/refundService.js";



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
    // Number("abc") is NaN and reached Prisma as a 500.
    const bookingIdNum = parseIdParam(typeof bookingId === "number" ? bookingId : String(bookingId));
    if (bookingIdNum === null) {
      return res.status(400).json({ message: "Invalid booking ID" });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingIdNum },
      include: { service: true, bookingVehicle: true },
    });

    if (!booking || !booking.service) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Not authorized for this booking" });
    }

    // Only a vendor-accepted, still-live booking can be paid for
    // (util/bookingStatus.js isBookingPayable). Orders used to be created for
    // any booking the caller owned -- one still awaiting the vendor, one the
    // vendor had declined, one already cancelled -- and the resulting capture
    // then confirmed it regardless. 409: the request is fine, the booking's
    // state is what rules it out.
    if (!isBookingPayable(booking)) {
      return res.status(409).json({
        message:
          booking.vendor_status !== "accepted"
            ? "The workshop has not accepted this booking yet, so it can't be paid for."
            : `This booking is ${booking.status} and can no longer be paid for.`,
        code: "BOOKING_NOT_PAYABLE",
      });
    }

    // Prefers BookingVehicle.price_snapshot (segment price at the time this
    // booking was created) over a fresh lookup of the service's current
    // price. See util/servicePricing.js — this is one of three sites that
    // must agree, or the webhook's cross-check below fails every payment.
    const amount = resolveBookingAmount(booking);

    // Razorpay's minimum order is ₹1 (100 paise). A booking priced at 0 (a
    // missing price_snapshot or a ₹0 service) used to reach the gateway and
    // come back as an opaque 502. Refuse it here with a reason instead.
    if (!Number.isFinite(Number(amount)) || Math.round(Number(amount) * 100) < 100) {
      console.error(`Create payment order: booking ${bookingIdNum} resolved to an unpayable amount (${amount})`);
      return res.status(422).json({
        message: "This booking has no payable amount",
        error: "This booking's price is missing, so it can't be paid online. Please contact support.",
        code: "INVALID_BOOKING_AMOUNT",
      });
    }

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
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID, 
      key: process.env.RAZORPAY_KEY_ID, 
      gateway: 'razorpay'
    };

    return res.json(responseData);
  } catch (error) {
    console.error("Create payment order error:", error);
    // The Razorpay SDK throws a plain { statusCode, error: { description } }
    // object, not an Error, for anything the gateway itself rejects
    // (including bad/test credentials — statusCode 401). That previously fell
    // through to a bare 500 with `error.message` (always undefined on this
    // shape), hiding a gateway-side problem behind a generic server-error
    // response. A failure Razorpay itself reported is an upstream/gateway
    // failure from our API's point of view, so it's surfaced as 502 with the
    // gateway's own description, not our own bug.
    // describeGatewayError (util/razorpayCredentials.js) gives a 401 (bad
    // keys) and a 400 amount error a message a user can read, and keeps the
    // gateway's raw text in `gatewayError` for support.
    if (error && typeof error.statusCode === 'number') {
      const { status, body } = describeGatewayError(error);
      return res.status(status).json(body);
    }
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

    const { payment, updatedBooking, platformFee, vendorAmount, bookingActive, refundOutcome, alreadyRecorded } = await verifyAndRecordPayment({
      bookingId,
      requestingUserId: req.user.id,
      orderId,
      paymentId,
      signature,
      gateway,
    });

    // The payment was captured, but for a booking that had already been
    // cancelled: recordSuccessfulPayment left it cancelled and refunded the
    // money. Tell the app plainly (bookingActive:false is additive -- older
    // app builds ignore it) and do NOT tell the vendor they were paid.
    if (bookingActive === false) {
      return res.json({
        success: true,
        paymentId: payment.id,
        bookingActive: false,
        refundInitiated: Boolean(refundOutcome?.refunded),
        message: refundOutcome?.refunded
          ? "This booking was cancelled before your payment arrived, so the full amount is being refunded."
          : "This booking was cancelled before your payment arrived. Our team will refund you shortly.",
      });
    }

    // Tell the vendor the job is on -- WITHOUT saying the customer paid.
    // Owner decision 2026-11-03: only Keplix needs to know about the payment.
    // This used to send PAYMENT_RECEIVED ("A customer has paid...") plus a
    // "payment_received" socket event carrying the amount. Now it is a neutral
    // BOOKING_READY notice and a plain "booking_updated" refresh signal.
    //
    // Skipped on a replayed verify (alreadyRecorded): the app retrying the
    // same verify used to notify the vendor a second time.
    const vendorId = updatedBooking?.service?.vendorId;
    if (vendorId && !alreadyRecorded) {
      const notice = renderNotification(NOTIFICATION_TYPES.BOOKING_READY, {
        serviceName: updatedBooking.service?.name,
        bookingId: updatedBooking.id,
      });
      await createNotification(vendorId, notice.title, notice.body, {
        type: notice.type,
        data: notice.data,
        bookingId: updatedBooking.id,
      });

      const io = req.app.get("io");
      if (io) {
        // No amount and no payment wording: screens only need to refresh.
        io.to(`user_${vendorId}`).emit("booking_updated", {
          bookingId: updatedBooking.id,
          status: updatedBooking.status,
        });
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

    // The dedupe row above is committed BEFORE processing runs, deliberately
    // -- two concurrent deliveries of the same webhook must not both pass the
    // "not yet seen" check and double-process a payment. That means a
    // transient failure during processing (a DB error mid-write, a captured
    // payment that can't yet be matched, etc.) leaves the dedupe row in place
    // with the actual event never handled. Razorpay retries on a non-2xx
    // response, but the retry's identical eventId would collide with this
    // row and be silently dropped as a duplicate -- permanently losing a
    // captured payment. Catching processing errors here and deleting the
    // dedupe row before returning 500 means the retry can go through cleanly
    // instead.
    try {
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

        // Refund outcomes. issueRefund writes 'gateway_confirmed' the moment the
        // API call returns, but the refund is only actually settled later —
        // without these two the row would never reach the truth.
        case 'refund.processed':
          await handleRefundProcessed(payload.refund.entity);
          break;

        case 'refund.failed':
          await handleRefundFailed(payload.refund.entity);
          break;


        default:
          Logger.info(`[Webhook] Unhandled event type: ${event}`);
      }
    } catch (processingError) {
      await prisma.webhookEvent
        .delete({ where: { eventId: String(eventId) } })
        .catch((cleanupErr) =>
          Logger.error(`[Webhook] Failed to roll back dedupe row for ${eventId} after processing error: ${cleanupErr.message}`)
        );
      throw processingError;
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
    // Every anticipated business-rule outcome above (no booking hint,
    // booking not found, amount mismatch) already returns gracefully via
    // `result.unresolved`/`result.mismatch` -- anything that reaches this
    // catch is by construction unexpected (a transient DB error, etc.).
    // Swallowing it here made the webhook ACK 200 even though nothing was
    // recorded, so Razorpay never even retried. Rethrowing lets the caller's
    // dedupe-rollback-and-500 logic run, so a real retry can follow.
    throw error;
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

        // Update booking back to pending -- but only from the pre-start
        // states a payment attempt can leave behind. Guarded because a late or
        // retried payment.failed used to pull a booking back to pending from
        // anywhere: un-cancelling a cancelled booking, or rolling an
        // in_progress job back to before the vendor had even started.
        if (existingPayment.bookingId) {
          await tx.booking.updateMany({
            where: { id: existingPayment.bookingId, status: { in: ['pending', 'confirmed'] } },
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
    // Same rationale as handlePaymentCaptured above: rethrow so an
    // unexpected error triggers the dedupe rollback and a real retry,
    // instead of a silent 200 that never happened.
    throw error;
  }
}

// Helper: Handle refund processed event
//
// Razorpay is the authority on whether the money reached the customer.
// issueRefund leaves a refund 'gateway_confirmed' until Razorpay says
// 'processed'; this (and util/refundReconciler.js) is that confirmation.
async function handleRefundProcessed(refundEntity) {
  try {
    const { id, payment_id } = refundEntity;

    const refund = await prisma.refund.findFirst({ where: { gatewayRefundId: id } });

    if (!refund) {
      // No row: made by hand in the Razorpay dashboard. Record it so the
      // payment, the vendor's share and admin's Refunds list all reflect it.
      const recorded = await recordDashboardRefund(refundEntity);
      if (!recorded) {
        Logger.warn(`[Webhook] refund.processed for refund ${id}: payment ${payment_id} is not one of ours`);
        return;
      }
      if (recorded.ours) {
        Logger.info(`[Webhook] refund.processed for ${id} arrived before refund ${recorded.ours.id} saved its id; the reconciler will finish it`);
        return;
      }
      Logger.warn(`[Webhook] Recorded dashboard refund ${id} for payment ${recorded.payment.id}`);
      if (recorded.payoutAlreadySettled) {
        Logger.error(
          `[MANUAL ACTION] Dashboard refund ${id} landed after the vendor payout for payment ${recorded.payment.id} -- the vendor's share needs recovering.`
        );
      }
      return;
    }

    const { changed } = await applyGatewayRefundOutcome(refund, 'processed', refundEntity);
    Logger.info(changed ? `[Webhook] Refund ${id} confirmed processed` : `[Webhook] Refund ${id} already processed, ignoring duplicate`);
  } catch (error) {
    Logger.error(`[Webhook] handleRefundProcessed error: ${error.message}`);
    // Same rationale as handlePaymentCaptured above.
    throw error;
  }
}

// Helper: Handle refund failed event
//
// The money did NOT reach the customer. applyGatewayRefundOutcome marks it
// gateway_failed (the one status refundService lets a retry re-reserve), puts
// a 'refunded' payment back to 'success' and restores the vendor's share.
async function handleRefundFailed(refundEntity) {
  try {
    const { id, payment_id } = refundEntity;

    const refund = await prisma.refund.findFirst({ where: { gatewayRefundId: id } });

    if (!refund) {
      // A failed dashboard refund moved no money, so there is nothing to record.
      Logger.warn(`[Webhook] refund.failed for unknown refund ${id} (payment ${payment_id})`);
      return;
    }

    const { changed } = await applyGatewayRefundOutcome(refund, 'failed', refundEntity);
    if (!changed) {
      // Out-of-order delivery: never walk back a refund Razorpay already
      // confirmed, or it would invite a second one.
      Logger.warn(`[Webhook] Ignored stale refund.failed for refund ${id} (status ${refund.status})`);
      return;
    }

    Logger.error(`[MANUAL ACTION] Refund ${id} failed at the gateway — customer has NOT been refunded.`);
    await notifyRefundFailed(refund.paymentId, id);
  } catch (error) {
    Logger.error(`[Webhook] handleRefundFailed error: ${error.message}`);
    // Same rationale as handlePaymentCaptured above.
    throw error;
  }
}

// Tells the customer their refund did not go through (audit #87). Best-effort:
// the refund is already recorded as failed whether or not this succeeds.
export async function notifyRefundFailed(paymentId, gatewayRefundId) {
  try {
    const bookingWithService = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { booking: { select: { id: true, userId: true, service: { select: { name: true } } } } },
    });
    const booking = bookingWithService?.booking;
    if (booking?.userId) {
      const failedNotification = renderNotification(NOTIFICATION_TYPES.REFUND_FAILED, {
        serviceName: booking.service?.name,
        bookingId: booking.id,
      });
      await createNotification(
        booking.userId,
        failedNotification.title,
        failedNotification.body,
        { type: failedNotification.type, data: failedNotification.data, bookingId: booking.id },
      );
    }
  } catch (notifyError) {
    Logger.error(`[Webhook] Failed to notify customer of refund failure for refund ${gatewayRefundId}: ${notifyError.message}`);
  }
}



