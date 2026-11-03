import { trimRazorpayEnv, keyMode, describeGatewayError } from '../../util/razorpayCredentials.js';

describe('trimRazorpayEnv', () => {
  test('trims surrounding whitespace/newlines and reports which vars changed', () => {
    const env = {
      RAZORPAY_KEY_ID: 'rzp_test_abc\n',
      RAZORPAY_KEY_SECRET: '  s3cret ',
      RAZORPAY_WEBHOOK_SECRET: 'clean',
      OTHER: '  untouched  ',
    };
    const changed = trimRazorpayEnv(env);
    expect(env.RAZORPAY_KEY_ID).toBe('rzp_test_abc');
    expect(env.RAZORPAY_KEY_SECRET).toBe('s3cret');
    expect(env.RAZORPAY_WEBHOOK_SECRET).toBe('clean');
    expect(env.OTHER).toBe('  untouched  ');
    expect(changed).toEqual(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']);
  });

  test('leaves unset vars unset', () => {
    const env = {};
    expect(trimRazorpayEnv(env)).toEqual([]);
    expect(env).toEqual({});
  });
});

describe('keyMode', () => {
  test.each([
    ['rzp_live_123', 'live'],
    ['rzp_test_123', 'test'],
    ['', 'missing'],
    [undefined, 'missing'],
    ['something_else', 'unknown'],
  ])('%p -> %p', (id, mode) => {
    expect(keyMode(id)).toBe(mode);
  });
});

describe('describeGatewayError', () => {
  test('401 -> friendly message, raw description kept for support', () => {
    const { status, body } = describeGatewayError({
      statusCode: 401, error: { description: 'Authentication failed' },
    });
    expect(status).toBe(502);
    expect(body.code).toBe('GATEWAY_AUTH_FAILED');
    expect(body.gatewayError).toBe('Authentication failed');
    expect(body.error).not.toMatch(/Authentication failed/);
  });

  test('400 about amount -> GATEWAY_INVALID_AMOUNT', () => {
    const { body } = describeGatewayError({
      statusCode: 400, error: { description: 'Order amount less than minimum amount allowed' },
    });
    expect(body.code).toBe('GATEWAY_INVALID_AMOUNT');
  });

  test('any other gateway error passes its description through', () => {
    const { status, body } = describeGatewayError({
      statusCode: 500, error: { description: 'Gateway down' },
    });
    expect(status).toBe(502);
    expect(body.code).toBe('GATEWAY_ERROR');
    expect(body.error).toBe('Gateway down');
  });

  test('missing description falls back safely', () => {
    expect(describeGatewayError({ statusCode: 502 }).body.error).toBe('Unknown gateway error');
  });
});
