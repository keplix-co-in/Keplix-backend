/**
 * Signed bill-link token (util/billToken.js), the printable bill page
 * (util/billHtml.js) and the earnings derivation (util/vendorEarnings.js).
 */
import { signBillToken, verifyBillToken, BILL_TOKEN_TTL_MS, BillLinkUnavailableError } from '../../util/billToken.js';
import { renderBillHtml, esc } from '../../util/billHtml.js';
import { deriveEarnings, summarizeEarnings } from '../../util/vendorEarnings.js';

const SECRET = 'a-test-secret-that-is-at-least-32-chars-long';
beforeEach(() => { process.env.BILL_LINK_SECRET = SECRET; });
afterAll(() => { delete process.env.BILL_LINK_SECRET; });

describe('bill token', () => {
  test('no secret or a short secret: signing throws BILL_LINK_UNAVAILABLE, verify returns null, no fallback', () => {
    const { token } = signBillToken({ billId: 7, role: 'user', actorId: 11 });
    for (const bad of [undefined, '', 'only-31-chars-xxxxxxxxxxxxxxx']) {
      if (bad === undefined) delete process.env.BILL_LINK_SECRET; else process.env.BILL_LINK_SECRET = bad;
      expect(() => signBillToken({ billId: 7, role: 'user', actorId: 11 })).toThrow(BillLinkUnavailableError);
      expect(verifyBillToken(token)).toBeNull();
    }
  });

  const claims = { billId: 7, role: 'user', actorId: 11 };

  test('round-trips and expires after 15 minutes', () => {
    const now = 1_000_000;
    const { token, expiresAt } = signBillToken(claims, now);
    expect(expiresAt.getTime()).toBe(now + BILL_TOKEN_TTL_MS);
    expect(BILL_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    expect(verifyBillToken(token, now + 1000)).toEqual(claims);
    expect(verifyBillToken(token, now + BILL_TOKEN_TTL_MS)).toBeNull();
  });

  test('a tampered payload or signature is rejected', () => {
    const { token } = signBillToken(claims);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ b: 8, r: 'user', a: 11, e: Date.now() + 1e9 })).toString('base64url');
    expect(verifyBillToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyBillToken(`${body}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(verifyBillToken(`${body}.${sig}.x`)).toBeNull();
  });

  test('garbage never throws', () => {
    for (const bad of [undefined, null, 5, '', 'abc', '.', 'a.b', 'x'.repeat(600)]) {
      expect(verifyBillToken(bad)).toBeNull();
    }
  });
});

describe('renderBillHtml', () => {
  const bill = {
    number: 'KPX-2026-000123',
    status: 'issued',
    issued_at: '2026-11-21T10:00:00Z',
    paid_at: null,
    labour_total: 3000,
    parts_total: 2000,
    total: 5000,
    lines: [{ name: '<script>alert(1)</script>', qty: 2, unit_price: 1000, line_total: 2000 }],
  };
  const base = { bill, taxInclusive: true, garageName: 'Raj & Sons', customerName: 'Rahul', serviceName: 'Brake service', bookingId: 100, nonce: 'abc' };

  test('is a "Final bill" with branding, number, lines and the tax-inclusive note, not a tax invoice', () => {
    const html = renderBillHtml(base);
    expect(html).toContain('<h1>Final bill</h1>');
    expect(html).toContain('Keplix');
    expect(html).toContain('KPX-2026-000123');
    expect(html).toContain('All prices include applicable taxes.');
    expect(html).toContain('not a tax invoice');
    expect(html).not.toMatch(/<h1>[^<]*Tax invoice/i);
    expect(html).toContain('Payment pending');
    expect(html).toContain('nonce="abc"');
  });

  test('escapes user-controlled text', () => {
    const html = renderBillHtml(base);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Raj &amp; Sons');
    expect(esc(`"'<`)).toBe('&quot;&#39;&lt;');
  });

  test('tax-exclusive wording, paid status and the customer-only platform fee', () => {
    const html = renderBillHtml({ ...base, taxInclusive: false, bill: { ...bill, status: 'paid', paid_at: '2026-11-22T10:00:00Z' }, platformFee: 50 });
    expect(html).toContain('exclude applicable taxes');
    expect(html).toContain('Paid on');
    expect(html).toContain('Keplix platform fee');
    expect(html).toContain('5,050.00');
    expect(renderBillHtml(base)).not.toContain('platform fee');
  });
});

describe('deriveEarnings', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const hours = (h) => new Date(now.getTime() + h * 3600 * 1000);
  const pay = (o = {}) => ({ status: 'success', amount: '5050.00', platformFee: '50.00', vendorAmount: '5000.00', vendorPayoutStatus: 'pending', payoutHoldUntil: null, ...o });
  const run = (b, p) => deriveEarnings(b, p, { autoConfirmHours: 48, now });

  test('unpaid / no payment', () => {
    expect(run({ status: 'in_progress' }, null)).toMatchObject({ payout_status: 'awaiting_payment', customer_paid: 0, payout_amount: 0 });
    expect(run({ status: 'cancelled' }, null).payout_status).toBe('not_applicable');
    expect(run({ status: 'in_progress' }, pay({ status: 'pending' })).payout_status).toBe('awaiting_payment');
  });

  test('paid but job not finished: after_completion, amounts from the Payment row, no commission', () => {
    expect(run({ status: 'in_progress' }, pay())).toEqual({
      customer_paid: 5050, platform_fee: 50, payout_amount: 5000, payout_status: 'after_completion', expected_payout_at: null,
    });
  });

  test('service_completed: waits for confirm window, or the hold if later', () => {
    const b = { status: 'service_completed', service_completed_at: now };
    expect(run(b, pay())).toMatchObject({ payout_status: 'awaiting_confirmation', expected_payout_at: hours(48).toISOString() });
    expect(run(b, pay({ payoutHoldUntil: hours(60) })).expected_payout_at).toBe(hours(60).toISOString());
  });

  test('confirmed: on_hold until payoutHoldUntil, then releasing', () => {
    expect(run({ status: 'user_confirmed' }, pay({ payoutHoldUntil: hours(5) }))).toMatchObject({ payout_status: 'on_hold', expected_payout_at: hours(5).toISOString() });
    expect(run({ status: 'user_confirmed' }, pay({ payoutHoldUntil: hours(-1) })).payout_status).toBe('releasing');
  });

  test('payout states: paid, settled, processing, failed, not_applicable', () => {
    const b = { status: 'completed' };
    expect(run(b, pay({ vendorPayoutStatus: 'paid' })).payout_status).toBe('paid');
    expect(run(b, pay({ vendorPayoutStatus: 'settled' })).payout_status).toBe('paid');
    expect(run(b, pay({ vendorPayoutStatus: 'processing' })).payout_status).toBe('releasing');
    expect(run(b, pay({ vendorPayoutStatus: 'failed' })).payout_status).toBe('failed');
    expect(run(b, pay({ vendorPayoutStatus: 'not_applicable' }))).toMatchObject({ payout_status: 'not_applicable', payout_amount: 0 });
  });

  test('refunded pays nothing; missing vendorAmount falls back to paid minus fee', () => {
    expect(run({ status: 'refunded' }, pay({ status: 'refunded' }))).toMatchObject({ payout_status: 'refunded', payout_amount: 0 });
    expect(run({ status: 'in_progress' }, pay({ vendorAmount: null })).payout_amount).toBe(5000);
  });

  test('summarizeEarnings totals paid-out, pending, failed and next payout', () => {
    const rows = [
      { payout_status: 'paid', customer_paid: 100.1, platform_fee: 0.1, payout_amount: 100, expected_payout_at: null },
      { payout_status: 'on_hold', customer_paid: 200, platform_fee: 10, payout_amount: 190, expected_payout_at: '2026-11-23T00:00:00.000Z' },
      { payout_status: 'awaiting_confirmation', customer_paid: 50, platform_fee: 5, payout_amount: 45, expected_payout_at: '2026-11-22T00:00:00.000Z' },
      { payout_status: 'failed', customer_paid: 10, platform_fee: 1, payout_amount: 9, expected_payout_at: null },
      { payout_status: 'refunded', customer_paid: 0, platform_fee: 0, payout_amount: 0, expected_payout_at: null },
      { payout_status: 'awaiting_payment', customer_paid: 0, platform_fee: 0, payout_amount: 0, expected_payout_at: null },
    ];
    expect(summarizeEarnings(rows)).toEqual({
      customer_paid_total: 360.1,
      platform_fee_total: 16.1,
      payout_paid_total: 100,
      payout_pending_total: 235,
      payout_failed_total: 9,
      refunded_count: 1,
      next_payout_at: '2026-11-22T00:00:00.000Z',
    });
  });
});
