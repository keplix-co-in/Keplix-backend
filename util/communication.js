import { messaging } from './firebase.js';
import Logger from './logger.js';

// Twilio supports two credential shapes: the classic Account SID + Auth
// Token pair, or an API Key (SK...) + Secret, which still needs the Account
// SID passed separately since an API Key SID isn't one. Both are accepted
// here since which one is configured varies by how the account was set up.
const hasTwilioCredentials = () =>
    !!process.env.TWILIO_ACCOUNT_SID &&
    ((process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET) || process.env.TWILIO_AUTH_TOKEN);

const getTwilioClient = async () => {
    const twilio = await import('twilio');
    if (process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET) {
        return twilio.default(
            process.env.TWILIO_API_KEY_SID,
            process.env.TWILIO_API_KEY_SECRET,
            { accountSid: process.env.TWILIO_ACCOUNT_SID }
        );
    }
    return twilio.default(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
};

export const sendEmail = async (to, subject, text, html = null) => {
    // Check if Resend is configured
    if (!process.env.RESEND_API_KEY) {
        Logger.warn("[Email] Resend not configured (Missing RESEND_API_KEY). Skipping.");
        Logger.info(`[MOCK EMAIL] To: ${to} | Subject: ${subject}`);
        return false;
    }

    try {
        // Dynamic import to avoid errors if resend package not installed
        const { Resend } = await import('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);

        const result = await resend.emails.send({
            from: process.env.EMAIL_FROM || 'Keplix <noreply@keplix.co.in>',
            to: [to],
            subject: subject,
            text: text,
            html: html || `<p>${text}</p>`
        });

        Logger.info(`[Resend] Email sent successfully to ${to}: ${result.id}`);
        return true;
    } catch (error) {
        Logger.error(`[Email] Failed to send: ${error.message}`);
        Logger.info(`[FALLBACK MOCK EMAIL] To: ${to} | Subject: ${subject}`);
        return false;
    }
};

export const sendSMS = async (to, message) => {
    // Check if Twilio is configured
    if (!hasTwilioCredentials()) {
        Logger.warn("[SMS] Twilio not configured (Missing TWILIO credentials). Skipping.");
        Logger.info(`[MOCK SMS] To: ${to} | Message: ${message}`);
        return false;
    }

    try {
        const client = await getTwilioClient();

        const result = await client.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: to
        });

        Logger.info(`[Twilio] SMS sent successfully to ${to}: ${result.sid}`);
        return true;
    } catch (error) {
        Logger.error(`[SMS] Failed to send: ${error.message}`);
        Logger.info(`[FALLBACK MOCK SMS] To: ${to} | Message: ${message}`);
        return false;
    }
};

/**
 * WhatsApp via Twilio. Deliberately not sendSMS with a different `to` prefix:
 * a business-initiated WhatsApp message outside the 24h session window
 * normally must reference a pre-approved Content Template by SID rather than
 * a free `body` string. Twilio also requires the `whatsapp:` address prefix
 * and a separate `from` number. Same env-guard-and-mock-log shape as sendSMS
 * so local dev without WhatsApp credentials behaves the same way.
 *
 * The Sandbox relaxes the template requirement: any number that has sent the
 * sandbox its join code can receive plain free-text messages from it, no
 * approved template needed. So when no contentSid is configured, this falls
 * back to sending `fallbackText` as a plain body instead of refusing outright
 * — which only works against the Sandbox number, not a real approved WhatsApp
 * Business sender. Once a real template SID is set, that path is used
 * instead and this fallback is unreachable.
 *
 * @param {string} to E.164 phone number, e.g. "+919876543210"
 * @param {string} contentSid Twilio Content Template SID (HXxxxx), or falsy to use fallbackText
 * @param {Record<string,string>} variables positional template variables, e.g. { "1": "Rahul", "2": "Royal Auto Care" }
 * @param {string} [fallbackText] plain-text body sent when contentSid is not set (Sandbox-only)
 */
export const sendWhatsApp = async (to, contentSid, variables = {}, fallbackText = null) => {
    if (!hasTwilioCredentials() || !process.env.TWILIO_WHATSAPP_FROM) {
        Logger.warn("[WhatsApp] Twilio WhatsApp not configured (Missing TWILIO_WHATSAPP_FROM or account credentials). Skipping.");
        Logger.info(`[MOCK WHATSAPP] To: ${to} | Template: ${contentSid || '(none, would use fallback text)'} | Vars: ${JSON.stringify(variables)}`);
        return false;
    }

    if (!contentSid && !fallbackText) {
        Logger.warn("[WhatsApp] No contentSid or fallbackText provided — nothing to send.");
        return false;
    }

    try {
        const client = await getTwilioClient();

        const message = contentSid
            ? {
                from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
                to: `whatsapp:${to}`,
                contentSid,
                contentVariables: JSON.stringify(variables),
            }
            : {
                from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
                to: `whatsapp:${to}`,
                body: fallbackText,
            };

        const result = await client.messages.create(message);

        Logger.info(`[Twilio] WhatsApp sent successfully to ${to}: ${result.sid}`);
        return true;
    } catch (error) {
        Logger.error(`[WhatsApp] Failed to send: ${error.message}`);
        Logger.info(`[FALLBACK MOCK WHATSAPP] To: ${to} | Template: ${contentSid || '(none)'}`);
        return false;
    }
};

export const sendPushNotification = async (token, title, body, data = {}) => {
    if (!token) {
        Logger.warn("No FCM Token provided via push notification.");
        return false;
    }

    const message = {
        notification: {
            title,
            body
        },
        data: data,
        token: token
    };

    try {
        const response = await messaging.send(message);
        Logger.info(`[FCM] Successfully sent message: ${response}`);
        return true;
    } catch (error) {
        Logger.error(`[FCM] Error sending message: ${error.message}`);
        return false;
    }
};
