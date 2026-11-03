import { jest } from '@jest/globals';
import {
  createRazorpayXClient,
  RazorpayXError,
  payoutModeFor,
  FAILED_PAYOUT_STATES,
} from '../../util/razorpayXClient.js';

const okResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const makeClient = (fetchImpl) =>
  createRazorpayXClient({ keyId: 'rzp_test_abc', keySecret: 'shh', fetchImpl });

describe('razorpayXClient', () => {
  test('sends Basic auth and JSON to the right endpoint', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ id: 'cont_1' }));
    const res = await makeClient(fetchImpl).createContact({ name: 'Shop' });

    expect(res).toEqual({ id: 'cont_1' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.razorpay.com/v1/contacts');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('rzp_test_abc:shh').toString('base64'));
    expect(JSON.parse(init.body)).toEqual({ name: 'Shop' });
  });

  test('createPayout sends the idempotency header so a retry cannot pay twice', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ id: 'pout_1', status: 'processing' }));
    await makeClient(fetchImpl).createPayout({ amount: 100 }, 'payout_payment_7');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.razorpay.com/v1/payouts');
    expect(init.headers['X-Payout-Idempotency']).toBe('payout_payment_7');
  });

  test('deactivateFundAccount PATCHes active:false', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ id: 'fa_1', active: false }));
    await makeClient(fetchImpl).deactivateFundAccount('fa_1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.razorpay.com/v1/fund_accounts/fa_1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ active: false });
  });

  test('fetchPayout GETs the payout by id', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ id: 'pout_1', status: 'processed' }));
    const res = await makeClient(fetchImpl).fetchPayout('pout_1');
    expect(res.status).toBe('processed');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.razorpay.com/v1/payouts/pout_1');
    expect(init.method).toBe('GET');
  });

  test('fetchFundAccount is a GET with no body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ id: 'fa_1', account_type: 'vpa' }));
    await makeClient(fetchImpl).fetchFundAccount('fa_1');
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  test("a Razorpay error becomes a RazorpayXError carrying Razorpay's reason", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse({ error: { code: 'BAD_REQUEST_ERROR', description: 'The RazorpayX Account number is invalid.' } }, 400)
    );
    const err = await makeClient(fetchImpl).createPayout({}).catch((e) => e);
    expect(err).toBeInstanceOf(RazorpayXError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('BAD_REQUEST_ERROR');
    expect(err.message).toContain('The RazorpayX Account number is invalid.');
  });

  test('a non-JSON error body still throws with the status code', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('html'); } });
    const err = await makeClient(fetchImpl).createContact({}).catch((e) => e);
    expect(err.statusCode).toBe(502);
  });

  test('missing credentials fail before any network call', async () => {
    const fetchImpl = jest.fn();
    const client = createRazorpayXClient({ keyId: '', keySecret: '', fetchImpl });
    await expect(client.createContact({})).rejects.toThrow(/credentials are not configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('payoutModeFor: UPI for a VPA, IMPS for a bank account', () => {
    expect(payoutModeFor({ account_type: 'vpa' })).toBe('UPI');
    expect(payoutModeFor({ account_type: 'bank_account' })).toBe('IMPS');
    expect(payoutModeFor(undefined)).toBe('IMPS');
  });

  test('failed payout states do not include accepted ones', () => {
    for (const s of ['queued', 'pending', 'processing', 'processed']) {
      expect(FAILED_PAYOUT_STATES).not.toContain(s);
    }
  });
});
