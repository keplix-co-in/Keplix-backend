/**
 * Customer-facing view of a booking's refund.
 *
 * Internal Refund.status values (initiated / gateway_confirmed / processed /
 * gateway_failed / reconciliation_needed) describe where money is in OUR
 * pipeline and mean nothing to a customer: "gateway_confirmed" reads as done
 * when it isn't, and "reconciliation_needed" would alarm someone whose money
 * has in fact already been returned. This collapses them into the four states
 * a customer can actually act on, plus null for "no refund in play".
 *
 * It takes the BOOKING, not just the refund rows, because "cancelled and paid
 * but no refund row exists" is a real state (a cancellation after work has
 * started is deliberately not auto-refunded) and must render as under-review
 * rather than as silence.
 */

// How long we tell customers a refund takes. Reliable for UPI; card and
// netbanking refunds routinely take longer because the bank, not Razorpay,
// decides when the credit lands. Kept as ONE constant so changing this promise
// is a single edit rather than a hunt through copy.
export const REFUND_ETA_HOURS = 24;
export const REFUND_ETA_TEXT = 'within 24 hours';

// Money moved: the gateway confirmed it. reconciliation_needed belongs here
// too — there the refund succeeded and only our own bookkeeping afterwards
// failed, which is not the customer's problem and must not look like one.
const SETTLED_STATUSES = ['processed', 'reconciliation_needed'];

const CANCELLED_STATUSES = ['cancelled', 'canceled'];

export const isCancelled = (status) => CANCELLED_STATUSES.includes(status);

/**
 * @returns {null | {status, amount, initiatedAt, expectedBy, message}}
 *   status: 'processing' | 'completed' | 'failed' | 'under_review'
 *   null means "show no refund UI at all".
 */
export const buildRefundView = ({ booking, payment }) => {
  // Nothing was ever charged, so there is nothing to refund. Showing refund
  // language here is what generates "where is my refund" tickets from people
  // who never paid.
  if (!payment || payment.status !== 'success') return null;

  const refunds = Array.isArray(payment.refunds) ? payment.refunds : [];

  if (refunds.length === 0) {
    // Paid, cancelled, but nothing was refunded — the cancellation came too
    // late for an automatic refund. Deliberately quotes NO amount: we have not
    // committed to paying anything yet, and a figure on screen reads as a
    // promise.
    if (isCancelled(booking?.status)) {
      return {
        status: 'under_review',
        amount: null,
        initiatedAt: null,
        expectedBy: null,
        message:
          'Our team is reviewing this cancellation and will contact you about a refund.',
      };
    }
    return null;
  }

  // gateway_failed rows released their claim on the money — the customer has
  // NOT been refunded, so they must never count toward the total.
  const live = refunds.filter((r) => r.status !== 'gateway_failed');

  if (live.length === 0) {
    return {
      status: 'failed',
      amount: null,
      initiatedAt: null,
      expectedBy: null,
      message:
        "We couldn't complete your refund. Please contact support and we'll sort it out.",
    };
  }

  const amount = live.reduce((sum, r) => sum + parseFloat(r.amount.toString()), 0);
  const initiatedAt = live.reduce(
    (earliest, r) => (!earliest || r.createdAt < earliest ? r.createdAt : earliest),
    null
  );
  const settled = live.every((r) => SETTLED_STATUSES.includes(r.status));

  return {
    status: settled ? 'completed' : 'processing',
    amount,
    initiatedAt,
    // An expectation, never a guarantee — see RefundTimeline, which renders the
    // final "credited" step as pending-with-a-date rather than complete,
    // because only the customer's bank knows when the money actually lands.
    expectedBy: initiatedAt
      ? new Date(new Date(initiatedAt).getTime() + REFUND_ETA_HOURS * 60 * 60 * 1000)
      : null,
    message: settled
      ? `Sent back to your original payment method — it should appear ${REFUND_ETA_TEXT}.`
      : `Your refund is on its way and should appear ${REFUND_ETA_TEXT}.`,
  };
};

export default buildRefundView;
