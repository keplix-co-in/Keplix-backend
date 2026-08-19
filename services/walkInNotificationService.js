import { sendWhatsApp, sendSMS } from '../util/communication.js';
import Logger from '../util/logger.js';

const PUBLIC_WEB_BASE_URL = process.env.PUBLIC_WEB_BASE_URL || 'https://keplix.co.in';

/**
 * WhatsApp-primary, SMS-fallback notification for a walk-in job. Sending both
 * unconditionally would mean every customer gets two identical messages and
 * we pay Twilio twice per job; this tries WhatsApp first (cheaper, richer)
 * and only falls back to SMS if WhatsApp fails or isn't configured.
 * NOTIFY_BOTH_CHANNELS=true overrides that and always sends both, in case
 * WhatsApp delivery rates in production turn out to be worse than expected.
 *
 * Callers MUST NOT let a failure here fail job creation — see
 * controllers/vendor/walkInJobController.js. This function itself never
 * throws; it returns a result object so the caller can persist delivery
 * status and expose a manual "resend" action.
 */
export async function sendJobSheetNotification({ customerName, customerPhone, vendorName, token }) {
  // No query string: some Indian carriers mangle "?" in transactional SMS.
  const trackingUrl = `${PUBLIC_WEB_BASE_URL}/job/${token}`;
  const firstName = (customerName || '').trim().split(/\s+/)[0] || 'there';

  const result = { whatsapp: false, sms: false, error: null };

  try {
    const contentSid = process.env.TWILIO_WHATSAPP_WALKIN_TEMPLATE_SID;
    result.whatsapp = await sendWhatsApp(customerPhone, contentSid, {
      '1': firstName,
      '2': vendorName,
      '3': trackingUrl,
    });

    const bothChannels = process.env.NOTIFY_BOTH_CHANNELS !== 'false';
    if (!result.whatsapp || bothChannels) {
      // Must match the DLT-registered SMS template exactly — DLT operators
      // silently drop unregistered content (Twilio still returns success),
      // so any wording change here needs the template re-approved first.
      const smsText = `Hi ${firstName}, your vehicle is checked in at ${vendorName}. Track status & view the health report: ${trackingUrl} - Keplix`;
      result.sms = await sendSMS(customerPhone, smsText);
    }
  } catch (error) {
    // sendWhatsApp/sendSMS already catch internally and return false rather
    // than throw, but this guards against something unexpected (e.g. a
    // malformed env var) still not being allowed to propagate into job
    // creation.
    result.error = error.message;
    Logger.error(`[WalkInNotification] Unexpected failure notifying ${customerPhone}: ${error.message}`);
  }

  return result;
}
