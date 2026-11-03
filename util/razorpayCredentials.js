// Razorpay credential hygiene + gateway-error mapping.
//
// WHY (2026-11-03): the user app's payments started failing with "Request
// failed with status code 502". The only 502 in createPaymentOrder is
// "Razorpay itself rejected orders.create" -- almost always bad credentials
// (401) or an amount under the ₹1 minimum (400). Two things made that hard
// to diagnose and easy to cause:
//   1. A key pasted into a GitHub secret / Cloud Run env with a trailing
//      newline or space is a *different* key to Razorpay -> 401, even though
//      it looks right in every console. So keys are trimmed once at boot.
//   2. Nothing ever said whether the server runs test or live keys, so a
//      test/live mix (key id from one mode, secret from the other) was
//      invisible. keyMode() is logged at startup -- the prefix only, never
//      the key itself.

const KEY_VARS = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'RAZORPAYX_KEY_ID',
  'RAZORPAYX_KEY_SECRET',
  'RAZORPAYX_ACCOUNT_NUMBER',
];

/**
 * Trim surrounding whitespace from the Razorpay env vars in place. Must run
 * before any module constructs a Razorpay client (config/env.js calls it,
 * and config/env.js is the second import in server.js/app.js).
 * Returns the names that were changed, so boot can say so.
 */
export function trimRazorpayEnv(envObj = process.env) {
  const changed = [];
  for (const name of KEY_VARS) {
    const value = envObj[name];
    if (typeof value === 'string' && value !== value.trim()) {
      envObj[name] = value.trim();
      changed.push(name);
    }
  }
  return changed;
}

/** 'live' | 'test' | 'missing' | 'unknown' -- from the key id prefix only. */
export function keyMode(keyId) {
  if (!keyId) return 'missing';
  if (keyId.startsWith('rzp_live_')) return 'live';
  if (keyId.startsWith('rzp_test_')) return 'test';
  return 'unknown';
}

/**
 * Turn the Razorpay SDK's thrown `{ statusCode, error: { code, description } }`
 * into the response createPaymentOrder sends. The app shows `error` to the
 * user and support, so it should say what actually went wrong.
 */
export function describeGatewayError(error) {
  const statusCode = error?.statusCode;
  const description = error?.error?.description || error?.message || 'Unknown gateway error';

  if (statusCode === 401) {
    return {
      status: 502,
      body: {
        message: 'Payment gateway rejected the request',
        code: 'GATEWAY_AUTH_FAILED',
        // Not the user's fault and not fixable by retrying -- it's our
        // configuration. Said plainly so support knows where to look.
        error: 'Payments are temporarily unavailable. Please try again later.',
        gatewayError: description,
      },
    };
  }

  if (statusCode === 400 && /amount/i.test(description)) {
    return {
      status: 502,
      body: {
        message: 'Payment gateway rejected the request',
        code: 'GATEWAY_INVALID_AMOUNT',
        error: "This booking's amount couldn't be charged. Please contact support.",
        gatewayError: description,
      },
    };
  }

  return {
    status: 502,
    body: {
      message: 'Payment gateway rejected the request',
      code: 'GATEWAY_ERROR',
      error: description,
      gatewayError: description,
    },
  };
}
