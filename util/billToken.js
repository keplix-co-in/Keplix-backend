import crypto from 'crypto';

/**
 * Short-lived signed link token for the printable final-bill page
 * (GET /bills/:id/view?t=...). A phone browser opening the bill cannot send
 * the app's bearer token, so an authenticated endpoint mints this instead.
 *
 * Format: base64url(JSON {b: billId, r: role, a: actorId, e: expiryMs}) + "." + HMAC.
 * Signed with a dedicated BILL_LINK_SECRET (min 32 chars) under a "bill-view:"
 * prefix. There is NO fallback: JWT_SECRET is retired (SYS-001, its prod value
 * was a known placeholder) and a default key would make every bill link
 * forgeable. Missing/short secret = signing throws BILL_LINK_UNAVAILABLE and
 * verification returns null (the view page answers 403).
 * No npm package, no DB row: expiry is inside the signed payload.
 */
export const BILL_TOKEN_TTL_MS = 15 * 60 * 1000;
export const BILL_LINK_SECRET_MIN_LENGTH = 32;

export class BillLinkUnavailableError extends Error {
  constructor() {
    super('BILL_LINK_SECRET is missing or shorter than 32 characters');
    this.code = 'BILL_LINK_UNAVAILABLE';
  }
}

const secret = () => {
  const s = process.env.BILL_LINK_SECRET;
  return typeof s === 'string' && s.length >= BILL_LINK_SECRET_MIN_LENGTH ? s : null;
};

const sign = (body, key) => crypto.createHmac('sha256', key).update(`bill-view:${body}`).digest('base64url');

export const signBillToken = ({ billId, role, actorId }, now = Date.now()) => {
  const key = secret();
  if (!key) throw new BillLinkUnavailableError();
  const expiresAt = now + BILL_TOKEN_TTL_MS;
  const body = Buffer.from(JSON.stringify({ b: billId, r: role, a: actorId, e: expiresAt })).toString('base64url');
  return { token: `${body}.${sign(body, key)}`, expiresAt: new Date(expiresAt) };
};

/** Returns { billId, role, actorId } or null (no secret, bad format/signature, expired). Never throws. */
export const verifyBillToken = (token, now = Date.now()) => {
  const key = secret();
  if (!key || typeof token !== 'string' || token.length > 500) return null;
  const [body, sig, ...extra] = token.split('.');
  if (!body || !sig || extra.length) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body, key));
  // timingSafeEqual needs equal lengths; a length mismatch is just a mismatch.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isInteger(p.b) || !['user', 'vendor'].includes(p.r) || !Number.isInteger(p.a)) return null;
    if (typeof p.e !== 'number' || p.e <= now) return null;
    return { billId: p.b, role: p.r, actorId: p.a };
  } catch {
    return null;
  }
};
