import crypto from 'crypto';
import Logger from './logger.js';

/**
 * Verify Razorpay webhook signature
 * @param {Object} req - Express request object
 * @param {string} webhookSecret - Razorpay webhook secret
 * @returns {boolean} - True if signature is valid
 */
export const verifyRazorpayWebhook = (req, webhookSecret) => {
  try {
    const receivedSignature = req.headers['x-razorpay-signature'];
    
    if (!receivedSignature) {
      Logger.warn('[Webhook] Missing x-razorpay-signature header');
      return false;
    }

    // Razorpay sends signature as HMAC SHA256 of the raw request body bytes.
    // Re-serializing req.body via JSON.stringify is unreliable (key order/whitespace
    // can differ from what was actually sent), so use the raw buffer captured by
    // express.json()'s verify callback (see server.js).
    if (!req.rawBody) {
      Logger.error('[Webhook] Missing raw body for signature verification');
      return false;
    }
    const body = req.rawBody;
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(body)
      .digest('hex');

    // Constant-time compare, and buffers must be equal length before
    // timingSafeEqual (it throws otherwise) — a length mismatch is just an
    // invalid signature, not an error.
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const receivedBuf = Buffer.from(String(receivedSignature), 'utf8');
    const isValid =
      expectedBuf.length === receivedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, receivedBuf);

    if (!isValid) {
      // Never log the expected signature: it's a valid HMAC for this exact
      // body, and logging it on every failed attempt effectively writes a
      // usable forged signature to disk for anyone who can read the logs.
      Logger.error('[Webhook] Invalid signature detected');
    }

    return isValid;
  } catch (error) {
    Logger.error(`[Webhook] Verification error: ${error.message}`);
    return false;
  }
};

/**
 * Verify RazorpayX payout webhook signature
 * @param {Object} req - Express request object
 * @param {string} webhookSecret - RazorpayX webhook secret
 * @returns {boolean} - True if signature is valid
 */
export const verifyRazorpayXWebhook = (req, webhookSecret) => {
  // RazorpayX uses same signature mechanism as Razorpay
  return verifyRazorpayWebhook(req, webhookSecret);
};

// `verifyPaymentSignature` used to live here: a client-payment-signature check
// that compared digests with `===` rather than a timing-safe comparison. It had
// no callers — services/paymentService.js does its own verification with
// crypto.timingSafeEqual — so it was removed rather than left as a
// ready-to-misuse copy of the same check without the timing safety.
