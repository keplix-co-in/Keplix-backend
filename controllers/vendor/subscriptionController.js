/**
 * Vendor + public side of garage subscriptions (docs/SUBSCRIPTIONS_API.md).
 * Thin: logic is in services/subscriptionService.js. Why this exists: owner
 * decision 2026-11-22, the gateway is used only for garage subscriptions.
 */
import {
  SubscriptionError, createSubscriptionOrder, getMySubscription, listMyPayments, listPlans,
  verifySubscriptionPayment,
} from '../../services/subscriptionService.js';

import { sendError } from '../../util/apiError.js';

const fail = (res, err, label) => {
  if (err instanceof SubscriptionError) {
    return sendError(res, err.status, err.code, err.message);
  }
  console.error(`[subscriptions] ${label} failed:`, err);
  return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'Something went wrong');
};

export const getPlans = async (req, res) => {
  try {
    return res.json(await listPlans());
  } catch (err) {
    return fail(res, err, 'plans');
  }
};

export const getMe = async (req, res) => {
  try {
    return res.json(await getMySubscription(req.user.id));
  } catch (err) {
    return fail(res, err, 'me');
  }
};

export const createOrder = async (req, res) => {
  try {
    // Only plan_code + period are read; any amount in the body is ignored (price is from the DB).
    const { plan_code, period } = req.body;
    return res.json(await createSubscriptionOrder({ vendorId: req.user.id, plan_code, period }));
  } catch (err) {
    if (err && typeof err.statusCode === 'number' && !(err instanceof SubscriptionError)) {
      console.error('[subscriptions] gateway error creating order:', err?.error?.description ?? err);
      return sendError(res, 502, 'GATEWAY_ERROR', 'Payment gateway error. Please try again.');
    }
    return fail(res, err, 'order');
  }
};

export const verify = async (req, res) => {
  try {
    return res.json(await verifySubscriptionPayment({ vendorId: req.user.id, ...req.body }));
  } catch (err) {
    return fail(res, err, 'verify');
  }
};

export const getPayments = async (req, res) => {
  try {
    return res.json(await listMyPayments(req.user.id));
  } catch (err) {
    return fail(res, err, 'payments');
  }
};
