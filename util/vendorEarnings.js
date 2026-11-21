/**
 * Vendor earnings view for a v2 booking (mockup G08): what the customer paid,
 * Keplix's fee, what the vendor receives, and where that payout is. Everything
 * is DERIVED from existing Payment fields and the booking status -- nothing
 * new is stored, and there is no commission (the 12% was dropped 2026-11-20;
 * the only deduction is Payment.platformFee as already recorded).
 */
import { PAYOUT_READY_BOOKING_STATUSES } from './payoutRules.js';

const num = (v) => (v === null || v === undefined ? null : Number(v.toString()));
const paise = (v) => Math.round((num(v) ?? 0) * 100);
const rupees = (p) => p / 100;

export const PAYOUT_STATUSES = [
  'awaiting_payment', // customer has not paid yet
  'after_completion', // paid; released once the job is done
  'awaiting_confirmation', // job done; customer confirm window running
  'on_hold', // escrow hold (payoutHoldUntil) still running
  'releasing', // queued / processing with the bank
  'paid',
  'failed',
  'refunded',
  'not_applicable',
];

const PENDING_PAYOUT = ['after_completion', 'awaiting_confirmation', 'on_hold', 'releasing'];

/**
 * @param {object} booking { status, service_completed_at }
 * @param {object|null} payment Payment row (amount, status, platformFee, vendorAmount, vendorPayoutStatus, payoutHoldUntil)
 * @param {object} [opts] { autoConfirmHours, now }
 */
export const deriveEarnings = (booking, payment, { autoConfirmHours = 48, now = new Date() } = {}) => {
  const base = { customer_paid: 0, platform_fee: 0, payout_amount: 0, payout_status: 'awaiting_payment', expected_payout_at: null };
  const dead = ['cancelled', 'canceled'].includes(booking?.status);

  if (!payment || !['success', 'refunded'].includes(payment.status)) {
    return { ...base, payout_status: dead ? 'not_applicable' : 'awaiting_payment' };
  }

  const paid = paise(payment.amount);
  const fee = paise(payment.platformFee);
  const payout = payment.vendorAmount != null ? paise(payment.vendorAmount) : Math.max(paid - fee, 0);
  const out = { customer_paid: rupees(paid), platform_fee: rupees(fee), payout_amount: rupees(payout), payout_status: 'releasing', expected_payout_at: null };

  if (payment.status === 'refunded' || booking?.status === 'refunded') return { ...out, payout_amount: 0, payout_status: 'refunded' };
  if (dead) return { ...out, payout_amount: 0, payout_status: 'not_applicable' };

  const vps = payment.vendorPayoutStatus;
  if (vps === 'paid' || vps === 'settled') return { ...out, payout_status: 'paid' };
  if (vps === 'processing') return { ...out, payout_status: 'releasing' };
  if (vps === 'failed') return { ...out, payout_status: 'failed' };
  if (vps === 'not_applicable') return { ...out, payout_amount: 0, payout_status: 'not_applicable' };

  // vps pending / null: depends on how far the job is.
  if (!PAYOUT_READY_BOOKING_STATUSES.includes(booking?.status)) return { ...out, payout_status: 'after_completion' };

  const holdUntil = payment.payoutHoldUntil ? new Date(payment.payoutHoldUntil) : null;
  if (booking.status === 'service_completed') {
    // Released when the customer confirms, or at the latest when the
    // auto-confirm window ends (cron), and never before the escrow hold ends.
    const completedAt = booking.service_completed_at ? new Date(booking.service_completed_at) : now;
    const latest = new Date(completedAt.getTime() + autoConfirmHours * 3600 * 1000);
    const at = holdUntil && holdUntil > latest ? holdUntil : latest;
    return { ...out, payout_status: 'awaiting_confirmation', expected_payout_at: at.toISOString() };
  }
  if (holdUntil && holdUntil > now) return { ...out, payout_status: 'on_hold', expected_payout_at: holdUntil.toISOString() };
  return { ...out, payout_status: 'releasing' };
};

/** Totals across many derived rows (the summary endpoint). */
export const summarizeEarnings = (rows) => {
  let paid = 0, fee = 0, paidOut = 0, pending = 0, failed = 0, refunded = 0;
  let nextPayoutAt = null;
  for (const r of rows) {
    if (r.payout_status === 'awaiting_payment' || r.payout_status === 'not_applicable') continue;
    if (r.payout_status === 'refunded') { refunded += 1; continue; }
    paid += paise(r.customer_paid);
    fee += paise(r.platform_fee);
    const p = paise(r.payout_amount);
    if (r.payout_status === 'paid') paidOut += p;
    else if (r.payout_status === 'failed') failed += p;
    else if (PENDING_PAYOUT.includes(r.payout_status)) {
      pending += p;
      if (r.expected_payout_at && (!nextPayoutAt || r.expected_payout_at < nextPayoutAt)) nextPayoutAt = r.expected_payout_at;
    }
  }
  return {
    customer_paid_total: rupees(paid),
    platform_fee_total: rupees(fee),
    payout_paid_total: rupees(paidOut),
    payout_pending_total: rupees(pending),
    payout_failed_total: rupees(failed),
    refunded_count: refunded,
    next_payout_at: nextPayoutAt,
  };
};
