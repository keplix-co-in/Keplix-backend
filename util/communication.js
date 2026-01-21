import { messaging } from './firebase.js';
import Logger from './logger.js';

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
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
        Logger.warn("[SMS] Twilio not configured (Missing TWILIO credentials). Skipping.");
        Logger.info(`[MOCK SMS] To: ${to} | Message: ${message}`);
        return false;
    }

    try {
        // Dynamic import to avoid errors if twilio package not installed
        const twilio = await import('twilio');
        const client = twilio.default(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );

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
