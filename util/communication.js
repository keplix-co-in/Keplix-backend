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
