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

    const isValid = receivedSignature === expectedSignature;
    
    if (!isValid) {
      Logger.error('[Webhook] Invalid signature detected');
      Logger.error(`[Webhook] Expected: ${expectedSignature}`);
      Logger.error(`[Webhook] Received: ${receivedSignature}`);
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

/**
 * Verify payment signature (for client-side payment verification)
 * @param {string} orderId - Razorpay order ID
 * @param {string} paymentId - Razorpay payment ID
 * @param {string} signature - Signature from client
 * @param {string} keySecret - Razorpay key secret
 * @returns {boolean} - True if signature is valid
 */
export const verifyPaymentSignature = (orderId, paymentId, signature, keySecret) => {
  try {
    const body = orderId + '|' + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(body)
      .digest('hex');

    return signature === expectedSignature;
  } catch (error) {
    Logger.error(`[Payment] Signature verification error: ${error.message}`);
    return false;
  }
};
