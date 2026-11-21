/**
 * Vendor side of pricing v2 (docs/PRICING_V2_API.md sections 3 and 4).
 * Thin: parse the id, call services/pricingV2Service.js, map errors.
 * Ownership, state rules, audit, sockets and notifications live in the service.
 */
import { parseIdParam } from '../../util/parseIdParam.js';
import {
  checkIn,
  completeWork,
  getPricing,
  addPhotos,
  createBillLink,
  getCustomerContact,
  recordPartsUsed,
  issueFinalBill,
  requestExtraWork,
  sendPricingError,
  PricingError,
  startInspection,
  startWork,
  voidFinalBill,
} from '../../services/pricingV2Service.js';

const ctxOf = (req, res) => {
  const bookingId = parseIdParam(req.params.id);
  if (!bookingId) {
    res.status(400).json({ success: false, message: 'Invalid booking id', code: 'VALIDATION_ERROR' });
    return null;
  }
  return { bookingId, actorId: req.user.id };
};

export const getVendorBookingPricing = async (req, res) => {
  const ctx = ctxOf(req, res);
  if (!ctx) return;
  try {
    const pricing = await getPricing({ ...ctx, role: 'vendor' });
    return res.status(200).json(pricing);
  } catch (err) {
    return sendPricingError(res, err, 'vendor get pricing');
  }
};

const action = (label, run) => async (req, res) => {
  const ctx = ctxOf(req, res);
  if (!ctx) return;
  try {
    const { status, body } = await run(ctx, req);
    return res.status(status).json(body);
  } catch (err) {
    return sendPricingError(res, err, label);
  }
};

export const vendorCheckIn = action('check-in', (ctx, req) => checkIn(ctx, req.body ?? {}));
export const vendorStartInspection = action('inspection/start', (ctx) => startInspection(ctx));
export const vendorStartWork = action('work/start', (ctx) => startWork(ctx));
export const vendorCompleteWork = action('work/complete', (ctx) => completeWork(ctx));
export const vendorRequestExtraWork = action('extra-work', (ctx, req) => requestExtraWork(ctx, req.body));
export const vendorIssueFinalBill = action('final-bill', (ctx) => issueFinalBill(ctx));
/**
 * Photos arrive via uploadFieldss([{name:'photos'}]) (middleware/uploadMiddleware.js,
 * the same Cloudinary path health sheets use), so req.files.photos[i].cloudinary
 * holds the stored asset. multipart text fields: kind ('check_in' | 'extra_work'),
 * request_id (extra_work only).
 */
export const vendorAddPhotos = action('photos', (ctx, req) => {
  const kind = req.body?.kind;
  if (!['check_in', 'extra_work'].includes(kind)) {
    throw new PricingError(400, 'VALIDATION_ERROR', "kind must be 'check_in' or 'extra_work'");
  }
  const requestId = kind === 'extra_work' ? parseIdParam(req.body?.request_id) : null;
  if (kind === 'extra_work' && !requestId) throw new PricingError(400, 'VALIDATION_ERROR', 'request_id is required for extra_work photos');
  const files = req.files?.photos ?? [];
  if (files.length === 0) throw new PricingError(400, 'VALIDATION_ERROR', 'Attach at least one photo in the "photos" field');
  // The shared uploader also accepts PDFs; job photos must be images.
  if (files.some((f) => f.cloudinary?.resource_type !== 'image' || !f.cloudinary?.secure_url)) {
    throw new PricingError(400, 'VALIDATION_ERROR', 'Only image files can be attached');
  }
  return addPhotos(ctx, { kind, requestId, urls: files.map((f) => f.cloudinary.secure_url) });
});

export const vendorPartsUsed = action('parts-used', (ctx, req) => recordPartsUsed(ctx, req.body.note));

export const vendorCustomerContact = async (req, res) => {
  const ctx = ctxOf(req, res);
  if (!ctx) return;
  try {
    return res.status(200).json(await getCustomerContact(ctx));
  } catch (err) {
    return sendPricingError(res, err, 'customer contact');
  }
};

export const vendorBillLink = async (req, res) => {
  const ctx = ctxOf(req, res);
  if (!ctx) return;
  try {
    const link = await createBillLink({ ...ctx, role: 'vendor' });
    // trust proxy is set in app.js, so protocol/host are the public ones.
    const url = `${req.protocol}://${req.get('host')}/bills/${link.bill_id}/view?t=${link.token}`;
    return res.status(200).json({ url, expires_at: link.expires_at });
  } catch (err) {
    return sendPricingError(res, err, 'bill link');
  }
};

export const vendorVoidFinalBill = action('final-bill/void', (ctx, req) => voidFinalBill(ctx, req.body));
