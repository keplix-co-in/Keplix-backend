/**
 * Customer side of pricing v2 (docs/PRICING_V2_API.md sections 3 and 5).
 * Thin: parse ids, call services/pricingV2Service.js, map errors.
 */
import { publicBaseUrl } from '../../util/publicBaseUrl.js';
import { parseIdParam } from '../../util/parseIdParam.js';
import {
  createBillLink,
  decideExtraWork,
  getPricing,
  requestCall,
  sendPricingError,
} from '../../services/pricingV2Service.js';

const badId = (res, what) =>
  res.status(400).json({ success: false, message: `Invalid ${what} id`, code: 'VALIDATION_ERROR' });

export const getUserBookingPricing = async (req, res) => {
  const bookingId = parseIdParam(req.params.id);
  if (!bookingId) return badId(res, 'booking');
  try {
    const pricing = await getPricing({ bookingId, role: 'user', actorId: req.user.id });
    return res.status(200).json(pricing);
  } catch (err) {
    return sendPricingError(res, err, 'user get pricing');
  }
};

const requestAction = (label, run) => async (req, res) => {
  const bookingId = parseIdParam(req.params.id);
  if (!bookingId) return badId(res, 'booking');
  const requestId = parseIdParam(req.params.requestId);
  if (!requestId) return badId(res, 'request');
  try {
    const { status, body } = await run({ bookingId, actorId: req.user.id }, requestId, req);
    return res.status(status).json(body);
  } catch (err) {
    return sendPricingError(res, err, label);
  }
};

export const userDecideExtraWork = requestAction('extra-work decision', (ctx, requestId, req) =>
  decideExtraWork(ctx, requestId, req.body, req.get?.('x-app-version') ?? req.headers?.['x-app-version'])
);

// Download Invoice (U07): returns a 15-minute signed URL for the printable bill page.
export const userBillLink = async (req, res) => {
  const bookingId = parseIdParam(req.params.id);
  if (!bookingId) return badId(res, 'booking');
  try {
    const link = await createBillLink({ bookingId, role: 'user', actorId: req.user.id });
    const url = `${publicBaseUrl(req)}/bills/${link.bill_id}/view?t=${link.token}`;
    return res.status(200).json({ url, expires_at: link.expires_at });
  } catch (err) {
    return sendPricingError(res, err, 'user bill link');
  }
};

export const userRequestCall = requestAction('extra-work call-request', (ctx, requestId) => requestCall(ctx, requestId));
