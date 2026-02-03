export const otpEmailTemplate = ({ otp, appName = "Keplix" }) => {
  return `
  <div style="font-family: Arial, sans-serif; background:#f4f4f4; padding:24px;">
    <div style="max-width:520px;margin:auto;background:#fff;border-radius:10px;padding:28px;">
      
      <h2 style="margin-bottom:8px;">${appName} Email Verification</h2>
      <p style="color:#555;">Use the OTP below to verify your email address.</p>

      <div style="
        margin:20px 0;
        padding:16px;
        background:#f9fafb;
        border-radius:8px;
        text-align:center;
      ">
        <span style="
          font-size:28px;
          letter-spacing:6px;
          font-weight:bold;
          color:#D82424;
        ">
          ${otp}
        </span>
      </div>

      <p style="font-size:14px;color:#333;">
        ⏱ This OTP is valid for <b>2 minutes</b>.
      </p>

      <p style="font-size:13px;color:#666;">
        If you didn’t request this, you can safely ignore this email.
      </p>

      <hr style="margin:24px 0;" />

      <p style="font-size:12px;color:#999;text-align:center;">
        © 2026 ${appName}
      </p>
    </div>
  </div>
  `;
};
