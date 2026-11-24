/**
 * Garage subscription payments (docs/SUBSCRIPTIONS_API.md).
 *
 * WHY (owner decision 2026-11-22): Razorpay is used ONLY for these. The amount
 * always comes from SubscriptionPlan in the DB, never from the client; verify
 * and the webhook share one idempotent "mark paid" so a replay can't extend
 * the subscription twice.
 */
import crypto from 'crypto';
import Razorpay from 'razorpay';
import prisma from '../util/prisma.js';
import Logger from '../util/logger.js';
// Own constant-time compare (not imported from paymentService.js) so this module
// has no dependency on the legacy payment service, which many tests mock.
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};
import {
  PAID_PERIODS, computeRenewal, describeSubscription, ensurePlansSeeded, getOrCreateSubscription,
} from '../util/subscription.js';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

export class SubscriptionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const rupees = (v) => Number(v.toString());
const toPaise = (v) => Math.round(rupees(v) * 100);

export const planOut = (p) => ({
  code: p.code,
  name: p.name,
  monthly_price: rupees(p.monthly_price),
  yearly_price: rupees(p.yearly_price),
  features: Array.isArray(p.features) ? p.features : [],
  sort_order: p.sort_order,
});

export const listPlans = async () => {
  await ensurePlansSeeded();
  const plans = await prisma.subscriptionPlan.findMany({ where: { is_active: true }, orderBy: { sort_order: 'asc' } });
  return plans.map(planOut);
};

export const getMySubscription = async (vendorId, now = new Date()) => {
  await ensurePlansSeeded();
  const sub = await getOrCreateSubscription(vendorId, now);
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code: sub.plan_code } });
  return describeSubscription(sub, plan, now);
};

export const listMyPayments = async (vendorId) => {
  const rows = await prisma.subscriptionPayment.findMany({
    where: { vendorId }, orderBy: { created_at: 'desc' }, take: 100,
  });
  return rows.map((r) => ({
    id: r.id, plan_code: r.plan_code, period: r.period, amount: rupees(r.amount), status: r.status,
    paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
  }));
};

/** POST /subscriptions/order. Amount (paise) is computed from the DB plan only. */
export const createSubscriptionOrder = async ({ vendorId, plan_code, period }) => {
  if (!PAID_PERIODS.includes(period)) {
    throw new SubscriptionError(400, 'VALIDATION_ERROR', "period must be 'monthly' or 'yearly'");
  }
  await ensurePlansSeeded();
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code: String(plan_code) } });
  if (!plan || !plan.is_active) throw new SubscriptionError(404, 'PLAN_NOT_FOUND', 'That plan is not available');
  const amount = period === 'yearly' ? plan.yearly_price : plan.monthly_price;
  const amountPaise = toPaise(amount);
  // Razorpay cannot take less than Rs 1; a free plan would need no payment at all.
  if (amountPaise < 100) throw new SubscriptionError(422, 'INVALID_PLAN_PRICE', 'This plan has no payable price');

  // Make sure the trial row exists BEFORE any money moves. markSubscriptionPaid
  // runs in a transaction, and a unique-violation (two requests racing to create
  // the row) inside a Postgres transaction aborts the whole tx, rolling back the
  // paid claim and failing the webhook. With the row already there it only reads.
  await getOrCreateSubscription(vendorId);

  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: `sub_${vendorId}_${Date.now()}`.slice(0, 40),
    notes: { type: 'subscription', vendorId: String(vendorId), plan_code: plan.code, period },
  });
  const orderId = order.id || order.orderId;
  await prisma.subscriptionPayment.create({
    data: { vendorId, plan_code: plan.code, period, amount: rupees(amount), razorpay_order_id: orderId, status: 'created' },
  });
  return {
    order_id: orderId,
    amount: amountPaise,
    currency: 'INR',
    key_id: process.env.RAZORPAY_KEY_ID,
    plan_code: plan.code,
    period,
  };
};

/**
 * Idempotent mark-paid shared by verify and the webhook. The order row is
 * CLAIMED with a guarded updateMany (status still not 'paid') inside the
 * transaction, so only the first caller extends the subscription.
 * Returns { applied: boolean, vendorId } (applied=false on a replay).
 */
export const markSubscriptionPaid = async ({ orderId, paymentId }, now = new Date()) => {
  return prisma.$transaction(async (tx) => {
    const row = await tx.subscriptionPayment.findUnique({ where: { razorpay_order_id: orderId } });
    if (!row) return { applied: false, vendorId: null, unknown: true };
    const { count } = await tx.subscriptionPayment.updateMany({
      where: { razorpay_order_id: orderId, status: { not: 'paid' } },
      data: { status: 'paid', razorpay_payment_id: paymentId, paid_at: now },
    });
    if (count === 0) return { applied: false, vendorId: row.vendorId };

    const sub = await getOrCreateSubscription(row.vendorId, now, tx);
    const { starts_at, ends_at } = computeRenewal(sub, row.period, now);
    await tx.vendorSubscription.update({
      where: { vendorId: row.vendorId },
      // Reminder marker reset so the next period's reminders fire again.
      data: { plan_code: row.plan_code, period: row.period, starts_at, ends_at, last_reminder_at: null },
    });
    return { applied: true, vendorId: row.vendorId };
  });
};

/** POST /subscriptions/verify. */
export const verifySubscriptionPayment = async ({ vendorId, razorpay_order_id, razorpay_payment_id, razorpay_signature }, now = new Date()) => {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  if (!safeEqual(expected, razorpay_signature)) {
    throw new SubscriptionError(400, 'INVALID_SIGNATURE', 'Invalid payment signature');
  }
  const row = await prisma.subscriptionPayment.findUnique({ where: { razorpay_order_id } });
  // 404 for someone else's order too: do not reveal which order ids exist.
  if (!row || row.vendorId !== vendorId) throw new SubscriptionError(404, 'ORDER_NOT_FOUND', 'Order not found');

  if (row.status !== 'paid') {
    // The signature proves the pair came from Razorpay, not that it was captured
    // or for how much: ask the gateway (same reasoning as services/paymentService.js).
    let payment;
    try {
      payment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch {
      throw new SubscriptionError(502, 'GATEWAY_ERROR', 'Unable to verify payment with gateway');
    }
    if (payment?.order_id !== razorpay_order_id || Number(payment?.amount) !== toPaise(row.amount)) {
      throw new SubscriptionError(400, 'PAYMENT_MISMATCH', 'Payment does not match this order');
    }
    if (payment.status !== 'captured') {
      throw new SubscriptionError(409, 'PAYMENT_NOT_CAPTURED', 'Payment is not captured yet');
    }
    await markSubscriptionPaid({ orderId: razorpay_order_id, paymentId: razorpay_payment_id }, now);
  }
  return getMySubscription(vendorId, now);
};

/**
 * Webhook branch for payment.captured / order.paid whose order notes say
 * type 'subscription'. The amount is checked against OUR row, not the notes.
 */
export const handleSubscriptionCaptured = async ({ orderId, paymentId, amountPaise }) => {
  const row = await prisma.subscriptionPayment.findUnique({ where: { razorpay_order_id: orderId } });
  if (!row) {
    Logger.error(`[Webhook] Subscription payment ${paymentId}: unknown order ${orderId} -- needs manual review`);
    return { unresolved: true };
  }
  if (amountPaise !== undefined && amountPaise !== null && Number(amountPaise) !== toPaise(row.amount)) {
    Logger.error(`[Webhook] Subscription payment ${paymentId}: amount ${amountPaise} != expected ${toPaise(row.amount)} -- needs manual review`);
    return { mismatch: true };
  }
  const result = await markSubscriptionPaid({ orderId, paymentId });
  return { applied: result.applied };
};

export const handleSubscriptionFailed = async ({ orderId }) => {
  if (!orderId) return;
  await prisma.subscriptionPayment.updateMany({ where: { razorpay_order_id: orderId, status: 'created' }, data: { status: 'failed' } });
};

export const isSubscriptionNotes = (notes) => notes?.type === 'subscription';
