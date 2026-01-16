import { messaging } from './firebase.js';

export const sendEmail = async (to, subject, text) => {
    // TODO: Integrate with Nodemailer / SendGrid / AWS SES
    console.log(`[MOCK EMAIL] To: ${to} | Subject: ${subject} | Body: ${text}`);
    return true; 
};

export const sendSMS = async (to, message) => {
    // TODO: Integrate with Twilio / Msg91
    console.log(`[MOCK SMS] To: ${to} | Message: ${message}`);
    return true;
};

export const sendPushNotification = async (token, title, body, data = {}) => {
    if (!token) {
        console.log("No FCM Token provided via push notification.");
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
        console.log('Successfully sent message:', response);
        return true;
    } catch (error) {
        console.error('Error sending message:', error);
        return false;
    }
};
