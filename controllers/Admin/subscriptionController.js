/**
 * Admin side of garage subscriptions (docs/SUBSCRIPTIONS_API.md).
 * Prices and features live in the DB (owner decision 2026-11-22/23) so the
 * admin can change them without a deploy. Writes are super_admin only (routes).
 */
import prisma from '../../util/prisma.js';
import Logger from '../../util/logger.js';
import { parseIdParam } from '../../util/parseIdParam.js';
import { clampLimit } from '../../util/parsePagination.js';
import { sendError } from '../../util/apiError.js';
import { GRACE_DAYS, ensurePlansSeeded, getOrCreateSubscription, subscriptionStatus } from '../../util/subscription.js';
import { planOut } from '../../services/subscriptionService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const listPlansAdmin = async (req, res) => {
  try {
    await ensurePlansSeeded();
    const plans = await prisma.subscriptionPlan.findMany({ orderBy: { sort_order: 'asc' } });
    return res.json(plans.map((p) => ({ ...planOut(p), is_active: p.is_active })));
  } catch (err) {
    Logger.error(`[Admin subscriptions] list plans: ${err.message}`);
    return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'Could not load plans');
  }
};

export const updatePlan = async (req, res) => {
  try {
    const code = String(req.params.code || '').toLowerCase();
    const existing = await prisma.subscriptionPlan.findUnique({ where: { code } });
    if (!existing) return sendError(res, 404, 'PLAN_NOT_FOUND', 'Plan not found');
    const plan = await prisma.subscriptionPlan.update({ where: { code }, data: req.body });
    Logger.warn(`[Admin subscriptions] admin ${req.user.id} updated plan ${code}: ${JSON.stringify(req.body)}`);
    return res.json({ ...planOut(plan), is_active: plan.is_active });
  } catch (err) {
    Logger.error(`[Admin subscriptions] update plan: ${err.message}`);
    return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'Could not update plan');
  }
};

// Status -> DB filter (status is derived, so it is expressed as ends_at ranges).
const statusWhere = (status, now) => {
  const grace = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
  switch (status) {
    case 'trial': return { period: 'trial', ends_at: { gt: now } };
    case 'active': return { period: { not: 'trial' }, ends_at: { gt: now } };
    case 'grace': return { ends_at: { lte: now, gt: grace } };
    case 'expired': return { ends_at: { lte: grace } };
    default: return null;
  }
};

export const listVendorSubscriptions = async (req, res) => {
  try {
    const now = new Date();
    const status = req.query.status ? String(req.query.status) : null;
    const filter = status ? statusWhere(status, now) : {};
    if (filter === null) return sendError(res, 400, 'VALIDATION_ERROR', 'status must be trial, active, grace or expired');
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = clampLimit(Math.min(100, Math.max(1, parseInt(req.query.limit) || 50)));
    const rows = await prisma.vendorSubscription.findMany({
      where: filter,
      orderBy: { ends_at: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { vendor: { select: { id: true, email: true, vendorProfile: { select: { business_name: true } } } } },
    });
    return res.json(rows.map((s) => ({
      vendor_id: s.vendorId,
      vendor_name: s.vendor?.vendorProfile?.business_name ?? null,
      email: s.vendor?.email ?? null,
      plan_code: s.plan_code,
      period: s.period,
      status: subscriptionStatus(s, now),
      ends_at: new Date(s.ends_at).toISOString(),
    })));
  } catch (err) {
    Logger.error(`[Admin subscriptions] list vendors: ${err.message}`);
    return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'Could not load subscriptions');
  }
};

export const extendVendorSubscription = async (req, res) => {
  try {
    const vendorId = parseIdParam(req.params.vendorId);
    if (vendorId === null) return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid vendor id');
    const { days, reason } = req.body;
    const vendor = await prisma.user.findUnique({ where: { id: vendorId }, select: { id: true, role: true } });
    if (!vendor || vendor.role !== 'vendor') return sendError(res, 404, 'NOT_FOUND', 'Vendor not found');

    const now = new Date();
    const sub = await getOrCreateSubscription(vendorId, now);
    // Same rule as a renewal: extend from max(now, ends_at).
    const base = Math.max(now.getTime(), new Date(sub.ends_at).getTime());
    const updated = await prisma.vendorSubscription.update({
      where: { vendorId },
      data: { ends_at: new Date(base + days * DAY_MS), last_reminder_at: null },
    });
    // No admin audit table exists (see controllers/Admin/bookingController.js
    // cancelNoShowBooking): the audit trail is this log line, as for other admin actions.
    Logger.warn(`[Admin subscriptions] admin ${req.user.id} extended vendor ${vendorId} by ${days} days. Reason: ${reason}`);
    return res.json({
      vendor_id: vendorId,
      plan_code: updated.plan_code,
      period: updated.period,
      status: subscriptionStatus(updated, now),
      ends_at: new Date(updated.ends_at).toISOString(),
    });
  } catch (err) {
    Logger.error(`[Admin subscriptions] extend: ${err.message}`);
    return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'Could not extend subscription');
  }
};

export const listSubscriptionPayments = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = clampLimit(Math.min(100, Math.max(1, parseInt(req.query.limit) || 50)));
    const rows = await prisma.subscriptionPayment.findMany({
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { vendor: { select: { email: true, vendorProfile: { select: { business_name: true } } } } },
    });
    return res.json(rows.map((r) => ({
      id: r.id,
      vendor_id: r.vendorId,
      vendor_name: r.vendor?.vendorProfile?.business_name ?? null,
      plan_code: r.plan_code,
      period: r.period,
      amount: Number(r.amount.toString()),
      status: r.status,
      razorpay_order_id: r.razorpay_order_id,
      razorpay_payment_id: r.razorpay_payment_id,
      paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null,
      created_at: new Date(r.created_at).toISOString(),
    })));
  } catch (err) {
    Logger.error(`[Admin subscriptions] list payments: ${err.message}`);
    return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'Could not load payments');
  }
};
