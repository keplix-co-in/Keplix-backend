import prisma from "../../util/prisma.js";
import { verifyRazorpayWebhook } from "../../util/webhookVerification.js";
import { createNotification } from "../../util/notificationHelper.js";
import { renderNotification, NOTIFICATION_TYPES } from "../../util/notificationTemplates.js";
import Logger from "../../util/logger.js";
import { recordCapturedPaymentFromWebhook } from "../../services/paymentService.js";
import { applyGatewayRefundOutcome, recordDashboardRefund } from "../../services/refundService.js";
import { handleSubscriptionCaptured, handleSubscriptionFailed, isSubscriptionNotes } from "../../services/subscriptionService.js";
import { sendError } from "../../util/apiError.js";

// PAY AT THE GARAGE (owner decision 2026-11-22; contract in
// docs/SUBSCRIPTIONS_API.md). Customers now pay the garage directly (cash or
// the garage's UPI) and the garage marks the bill paid, so the customer-side
// gateway endpoints are retired. The routes stay (shipped app builds still
// call them) and answer 410 PAY_AT_GARAGE so those apps can show "pay the
// garage". The old order/quote/verify code is deleted -- git history keeps it.
// The webhook below still settles ORDERS THAT ALREADY EXISTED, so a customer
// who paid just before this shipped is never left unrecorded.
const payAtGarage = (res) =>
  sendError(res, 410, 'PAY_AT_GARAGE', 'Online payment for bookings is closed. Please pay the garage directly (cash or UPI).');

export const createPaymentOrder = async (req, res) => payAtGarage(res);
export const getPaymentQuote = async (req, res) => payAtGarage(res);
export const verifyPayment = async (req, res) => payAtGarage(res);

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
          // Garage subscription orders (2026-11-22 decision) are also settled
          // from order.paid; same idempotent mark-paid as payment.captured.
          if (isSubscriptionNotes(payload.order.entity.notes) && payload.payment?.entity?.id) {
            await handleSubscriptionCaptured({
              orderId: payload.order.entity.id,
              paymentId: payload.payment.entity.id,
              amountPaise: payload.payment.entity.amount,
            });
          }
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

    // Garage subscription (owner decision 2026-11-22: the gateway is used ONLY
    // for subscriptions now). Decided by OUR SubscriptionPayment row, never by
    // the payment's own notes alone (checkout lets a client set those); an
    // order we have no row for falls through to the booking path below, which
    // still serves old booking orders so no money goes unrecorded.
    if (isSubscriptionNotes(notes)) {
      const sub = await handleSubscriptionCaptured({ orderId: order_id, paymentId: id, amountPaise: amount });
      if (!sub.unresolved) return;
    }

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
      notes, // may carry the frozen on-top fee; service falls back to the order
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

    if (isSubscriptionNotes(payment.notes)) {
      await handleSubscriptionFailed({ orderId: payment.order_id });
    }

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



