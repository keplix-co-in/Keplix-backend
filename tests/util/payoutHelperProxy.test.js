import { jest } from '@jest/globals';

// payoutHelper must send RazorpayX calls through the payout proxy when
// RAZORPAYX_PROXY_URL is set (RazorpayX IP allowlist, see util/proxyFetch.js),
// and call directly when it isn't.

const createRazorpayXClient = jest.fn(() => ({ fetchPayout: jest.fn().mockResolvedValue({ id: 'pout_1' }) }));
const proxyFetch = jest.fn();
const createProxyFetch = jest.fn(() => proxyFetch);

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../util/razorpayXClient.js', () => ({
  createRazorpayXClient,
  FAILED_PAYOUT_STATES: ['failed', 'rejected', 'cancelled', 'reversed'],
  payoutModeFor: () => 'IMPS',
}));
jest.unstable_mockModule('../../util/proxyFetch.js', () => ({ createProxyFetch }));

const { fetchVendorPayout, __setRazorpayXClientForTests } = await import('../../util/payoutHelper.js');

const ORIGINAL = process.env.RAZORPAYX_PROXY_URL;

beforeEach(() => {
  jest.clearAllMocks();
  __setRazorpayXClientForTests(null); // force getClient() to build a new client
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.RAZORPAYX_PROXY_URL;
  else process.env.RAZORPAYX_PROXY_URL = ORIGINAL;
});

describe('payoutHelper RazorpayX client', () => {
  it('routes through the proxy when RAZORPAYX_PROXY_URL is set', async () => {
    process.env.RAZORPAYX_PROXY_URL = '  http://keplix:pw@10.0.0.1:8888 ';
    await fetchVendorPayout('pout_1');

    expect(createProxyFetch).toHaveBeenCalledWith('http://keplix:pw@10.0.0.1:8888');
    expect(createRazorpayXClient).toHaveBeenCalledTimes(1);
    expect(createRazorpayXClient.mock.calls[0][0].fetchImpl).toBe(proxyFetch);
  });

  it('calls RazorpayX directly when RAZORPAYX_PROXY_URL is unset or blank', async () => {
    for (const value of [undefined, '', '   ']) {
      __setRazorpayXClientForTests(null);
      if (value === undefined) delete process.env.RAZORPAYX_PROXY_URL;
      else process.env.RAZORPAYX_PROXY_URL = value;

      await fetchVendorPayout('pout_1');
      expect(createRazorpayXClient.mock.lastCall[0].fetchImpl).toBeUndefined();
    }
    expect(createProxyFetch).not.toHaveBeenCalled();
  });
});
