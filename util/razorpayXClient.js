// Minimal RazorpayX (payouts) REST client.
//
// WHY (2026-11-03): payoutHelper used to call razorpayX.contacts.create,
// razorpayX.fund_accounts.create/update and razorpayX.payouts.create on the
// `razorpay` npm SDK. That SDK (v2.9.x) has no contacts or payouts resource
// at all, and its fund-account resource is `fundAccount` with create/fetch
// only. Every call threw "Cannot read properties of undefined (reading
// 'create')" before reaching Razorpay, so no vendor payout account was ever
// created and no payout ever ran (prod logs: vendors 442 and 948). The unit
// tests mocked payoutHelper wholesale, so nothing caught it.
//
// RazorpayX is a plain REST API with the same Basic auth as the payment
// gateway, so this calls it directly instead of depending on SDK coverage.
// Docs: https://razorpay.com/docs/api/x/

const BASE_URL = 'https://api.razorpay.com/v1';

export class RazorpayXError extends Error {
  constructor(message, { statusCode, code, field } = {}) {
    super(message);
    this.name = 'RazorpayXError';
    this.statusCode = statusCode;
    this.code = code;
    this.field = field;
  }
}

/**
 * @param {object}   opts
 * @param {string}   opts.keyId
 * @param {string}   opts.keySecret
 * @param {Function} [opts.fetchImpl] injectable for tests; defaults to global fetch
 */
export function createRazorpayXClient({ keyId, keySecret, fetchImpl = globalThis.fetch } = {}) {
  const auth = 'Basic ' + Buffer.from(`${keyId || ''}:${keySecret || ''}`).toString('base64');

  async function request(method, path, body, extraHeaders = {}) {
    if (!keyId || !keySecret) {
      throw new RazorpayXError('RazorpayX credentials are not configured (RAZORPAYX_KEY_ID / RAZORPAYX_KEY_SECRET)');
    }
    const res = await fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // Non-JSON body (gateway HTML error page etc.) -- fall through with {}.
    }
    if (!res.ok) {
      const err = data?.error || {};
      throw new RazorpayXError(
        `RazorpayX ${method} ${path.split('?')[0]} failed (HTTP ${res.status}): ${err.description || 'no description'}`,
        { statusCode: res.status, code: err.code, field: err.field }
      );
    }
    return data;
  }

  return {
    /** POST /contacts -- Razorpay returns the existing contact for identical details. */
    createContact: (contact) => request('POST', '/contacts', contact),
    /** POST /fund_accounts (bank_account or vpa). */
    createFundAccount: (fundAccount) => request('POST', '/fund_accounts', fundAccount),
    /** GET /fund_accounts/:id -- used to pick the payout mode (UPI vs IMPS). */
    fetchFundAccount: (id) => request('GET', `/fund_accounts/${encodeURIComponent(id)}`),
    /** PATCH /fund_accounts/:id {active:false} -- fund accounts can't be deleted, only deactivated. */
    deactivateFundAccount: (id) =>
      request('PATCH', `/fund_accounts/${encodeURIComponent(id)}`, { active: false }),
    /**
     * POST /payouts. The idempotency key makes a retried request return the
     * original payout instead of sending the money twice.
     */
    createPayout: (payout, idempotencyKey) =>
      request('POST', '/payouts', payout, idempotencyKey ? { 'X-Payout-Idempotency': idempotencyKey } : {}),
    /** GET /payouts/:id -- the payout's current status, polled until it settles. */
    fetchPayout: (id) => request('GET', `/payouts/${encodeURIComponent(id)}`),
  };
}

// Payout states Razorpay reports when it has refused or undone the transfer.
// See https://razorpay.com/docs/x/payouts/states-life-cycle/
export const FAILED_PAYOUT_STATES = ['rejected', 'failed', 'cancelled', 'reversed'];

// The ONLY state that means the money reached the vendor. queued, pending
// and processing are accepted-but-not-paid: a queued payout (low balance)
// can sit for days and still end up cancelled.
export const PAID_PAYOUT_STATE = 'processed';

/**
 * Payout mode for a fund account. A VPA (UPI id) can only be paid over UPI;
 * IMPS to a VPA is rejected by RazorpayX. Bank accounts use IMPS (instant,
 * 24x7, up to ₹5 lakh).
 */
export function payoutModeFor(fundAccount) {
  return fundAccount?.account_type === 'vpa' ? 'UPI' : 'IMPS';
}
