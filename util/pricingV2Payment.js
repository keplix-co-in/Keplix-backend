/**
 * Pricing v2: what happens to a v2 booking when its payment is recorded as
 * successful. Shared by every path that records a success
 * (services/paymentService.js recordSuccessfulPayment for verify + webhook,
 * util/paymentReconciliation.js for the cron), so the three cannot drift.
 *
 * Runs INSIDE the caller's payment transaction. Three jobs:
 *
 *  1. Settle the bill: issued -> paid, plus a final_bill_paid BookingEvent.
 *
 *  2. Escrow (review fix 2026-11-21). A legacy booking is paid before the job
 *     and gets its payout hold + customer confirm window at completion
 *     (controllers/vendor/bookingController.js updateBookingStatus). A v2
 *     booking is usually completed BEFORE it is paid, so at completion there
 *     was no Payment row to hold, and the confirm window
 *     (service_completed_at, read by the auto-confirm cron) had been running
 *     while the customer could not even pay. A bill paid 47h after completion
 *     was auto-confirmed and paid out ~1h later, with no hold. So, on payment:
 *     the same payoutHoldUntil completion sets (resolvePayoutHoldUntil, i.e.
 *     PlatformSettings.payoutHoldHours), and service_completed_at restarted
 *     to now (only if the booking is already service_completed) so the
 *     customer gets the same AUTO_CONFIRM_HOURS window a legacy booking gets.
 *     No new durations: both come from the existing settings/cron.
 *
 *  3. Void race alert (review fix 2026-11-21). The bill can be voided after
 *     the Razorpay order was made (the void and the capture do not share a
 *     lock). The money has moved, so the payment is still recorded (no
 *     auto-refund), but it is no longer silent: a BookingEvent
 *     ('payment_bill_mismatch') is written and an alert string is returned
 *     for the caller to log as [MANUAL ACTION] after commit -- the same
 *     tagged-log convention the rest of the payment code uses, since there is
 *     no admin alert table. Two cases: the charged bill is void by the time
 *     the payment lands, or the order was made for an older bill than the
 *     one it was charged against (re-issued with the same total).
 */

export const BILL_MISMATCH_EVENT = 'payment_bill_mismatch';

/**
 * @param {object} tx Prisma transaction client
 * @param {object} p
 * @param {number} p.bookingId
 * @param {number} p.finalBillId the open bill the charge was resolved against
 * @param {string|number|null} [p.orderFinalBillId] notes.finalBillId of the Razorpay order
 * @param {number} p.paymentId Payment row id
 * @param {number} p.amount rupees recorded
 * @param {Date|null} p.holdUntil from resolvePayoutHoldUntil (null = no hold configured)
 * @param {Date} [p.now]
 * @param {object} [p.eventPayload] extra audit fields (e.g. razorpayPaymentId, via)
 * @returns {Promise<{billSettled:boolean, alerts:string[]}>}
 */
export const settleV2PaymentInTx = async (tx, {
  bookingId,
  finalBillId,
  orderFinalBillId = null,
  paymentId,
  amount,
  holdUntil = null,
  now = new Date(),
  eventPayload = {},
}) => {
  const alerts = [];

  const billUpdate = await tx.finalBill.updateMany({
    where: { id: finalBillId, bookingId, status: 'issued' },
    data: { status: 'paid', paid_at: now },
  });
  const billSettled = billUpdate.count > 0;
  if (billSettled) {
    await tx.bookingEvent.create({
      data: {
        bookingId,
        actor_role: 'system',
        actor_id: null,
        type: 'final_bill_paid',
        payload: { finalBillId, paymentId, amount, ...eventPayload },
      },
    });
  } else {
    // count 0 is fine when the bill is already 'paid' (a replay, or another
    // path recorded it first). Anything else means it was voided meanwhile.
    const bill = await tx.finalBill.findUnique({ where: { id: finalBillId }, select: { status: true } });
    if (bill?.status !== 'paid') {
      alerts.push(
        `Payment ${paymentId} (Rs ${amount}) on booking ${bookingId} was captured for bill ${finalBillId}, ` +
        `which is now ${bill?.status ?? 'missing'}. Payment kept; check the booking's bill and whether a refund or re-bill is needed.`,
      );
    }
  }

  if (orderFinalBillId != null && String(orderFinalBillId) !== String(finalBillId)) {
    alerts.push(
      `Payment ${paymentId} (Rs ${amount}) on booking ${bookingId} came from an order made for bill ${orderFinalBillId}, ` +
      `but was recorded against bill ${finalBillId} (the earlier bill was voided and re-issued with the same total). Check it.`,
    );
  }

  if (alerts.length > 0) {
    await tx.bookingEvent.create({
      data: {
        bookingId,
        actor_role: 'system',
        actor_id: null,
        type: BILL_MISMATCH_EVENT,
        payload: { finalBillId, orderFinalBillId: orderFinalBillId ?? null, paymentId, amount, ...eventPayload },
      },
    });
  }

  if (holdUntil) {
    await tx.payment.update({ where: { id: paymentId }, data: { payoutHoldUntil: holdUntil } });
  }
  // Restart the confirm window only for an already-completed booking; an
  // in_progress one gets it (and a fresh hold) from completion as usual.
  await tx.booking.updateMany({
    where: { id: bookingId, status: 'service_completed' },
    data: { service_completed_at: now },
  });

  return { billSettled, alerts };
};

export default { settleV2PaymentInTx, BILL_MISMATCH_EVENT };
