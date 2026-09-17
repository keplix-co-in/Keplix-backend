/**
 * Regression test for audit #14: the Razorpay webhook handler (signature
 * verify, replay dedupe, unconfigured-secret guard) had zero test coverage.
 * This covers verifyRazorpayWebhook itself; the unconfigured-secret guard in
 * the handler is covered separately in
 * tests/controllers/user/webhookHandler.test.js.
 */
import crypto from 'crypto';
import { verifyRazorpayWebhook } from '../../util/webhookVerification.js';

const SECRET = 'whsec_test_12345';

const mockReq = (body, { signature, noRawBody = false } = {}) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const sig = signature ?? crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  return {
    headers: { 'x-razorpay-signature': sig },
    rawBody: noRawBody ? undefined : rawBody,
    body,
  };
};

describe('verifyRazorpayWebhook', () => {
  test('accepts a correctly signed body', () => {
    const req = mockReq({ event: 'payment.captured' });
    expect(verifyRazorpayWebhook(req, SECRET)).toBe(true);
  });

  test('rejects a body signed with the wrong secret', () => {
    const req = mockReq({ event: 'payment.captured' });
    expect(verifyRazorpayWebhook(req, 'a_different_secret')).toBe(false);
  });

  test('rejects a tampered body (signature no longer matches)', () => {
    const req = mockReq({ event: 'payment.captured', amount: 500 });
    req.rawBody = Buffer.from(JSON.stringify({ event: 'payment.captured', amount: 500000 }));
    expect(verifyRazorpayWebhook(req, SECRET)).toBe(false);
  });

  test('rejects a request missing the signature header', () => {
    const req = mockReq({ event: 'payment.captured' });
    delete req.headers['x-razorpay-signature'];
    expect(verifyRazorpayWebhook(req, SECRET)).toBe(false);
  });

  test('rejects a request missing the raw body', () => {
    const req = mockReq({ event: 'payment.captured' }, { noRawBody: true });
    expect(verifyRazorpayWebhook(req, SECRET)).toBe(false);
  });

  test('rejects a signature of a different length (no timingSafeEqual throw)', () => {
    const req = mockReq({ event: 'payment.captured' }, { signature: 'short' });
    expect(verifyRazorpayWebhook(req, SECRET)).toBe(false);
  });

  test('never throws, even on unexpected input', () => {
    const req = { headers: {}, rawBody: null };
    expect(() => verifyRazorpayWebhook(req, SECRET)).not.toThrow();
    expect(verifyRazorpayWebhook(req, SECRET)).toBe(false);
  });
});
