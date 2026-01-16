import { messaging } from './firebase.js';
import Logger from './logger.js';

export const sendEmail = async (to, subject, text) => {
    // Check Config
    if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER) {
        Logger.warn("[Email] Not configured (Missing EMAIL_HOST/USER). Skipping.");
        return false;
    }
    
    // TODO: Integrate with Nodemailer / SendGrid / AWS SES
    Logger.info(`[MOCK EMAIL] To: ${to} | Subject: ${subject}`);
    return true; 
};

export const sendSMS = async (to, message) => {
    // Check Config
    if (!process.env.SMS_API_KEY) {
        Logger.warn("[SMS] Not configured (Missing SMS_API_KEY). Skipping.");
        return false;
    }

    // TODO: Integrate with Twilio / Msg91
    Logger.info(`[MOCK SMS] To: ${to} | Message: ${message}`);
    return true;
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
