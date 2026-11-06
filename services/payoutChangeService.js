/**
 * Security A-023: step-up verification for payout account changes.
 *
 * A stolen session used to be enough to swap a vendor's bank/UPI details and
 * have the next payout land in the attacker's account. Now:
 *   - POST /accounts/vendor/profile/payout-otp emails a 6-digit code to the
 *     ACCOUNT email (stored as an HMAC, attempt-limited, purpose
 *     "payout_change" so login codes can't be used here).
 *   - Any profile write that CHANGES bank_account_number, ifsc_code,
 *     bank_account_holder_name or upi_id must carry `payout_otp`, unless the
 *     vendor has no fund account yet (first-time setup).
 *   - After a change, payoutAccountChangedAt is set (24h payout hold, see
 *     util/payoutRules.js) and the vendor is emailed + notified.
 */
import prisma from "../util/prisma.js";
import { generateOTP, hashOTP, consumeOtpAttempt, claimOtp } from "../util/otp.js";
import { sendEmail } from "../util/communication.js";
import { otpEmailTemplate } from "../util/emailTemplate.js";
import { createNotification } from "../util/notificationHelper.js";
import { renderNotification, NOTIFICATION_TYPES } from "../util/notificationTemplates.js";
import Logger from "../util/logger.js";

export const PAYOUT_FIELDS = ["bank_account_number", "ifsc_code", "bank_account_holder_name", "upi_id"];
export const PAYOUT_OTP_PURPOSE = "payout_change";
export const PAYOUT_OTP_TTL_MS = 10 * 60 * 1000;

const norm = (v) => (v === undefined || v === null ? "" : String(v).trim());

/** True when `incoming` would change any payout field from `current`. */
export const payoutFieldsChanging = (current, incoming) =>
  PAYOUT_FIELDS.some((f) => incoming?.[f] !== undefined && norm(incoming[f]) !== norm(current?.[f]));

/**
 * Decide whether this write needs (and has) a valid payout OTP.
 * @returns {Promise<{ok:true, changed:boolean}|{ok:false, status:number, body:object}>}
 *   changed=true means an existing fund account is being changed (apply the
 *   24h hold + alert); false means no change or first-time setup.
 */
export const checkPayoutChange = async (userId, current, incoming, payoutOtp) => {
  if (!payoutFieldsChanging(current, incoming)) return { ok: true, changed: false };
  const account = await prisma.vendorPayoutAccount.findUnique({ where: { vendorId: userId } });
  // First-time setup: nothing to hijack yet, so no OTP and no hold.
  if (!account) return { ok: true, changed: false };

  // Onboarding exception (documented choice): the vendor app's onboarding
  // screen has no OTP step and re-submits bank details on retry. While the
  // profile is not yet onboarded the change is allowed without a code, but it
  // still gets the 24h payout hold and the alert (changed:true). Once
  // onboarding_completed is true (server-derived) the OTP is mandatory.
  if (current && current.onboarding_completed === false) return { ok: true, changed: true };

  const candidate = norm(payoutOtp);
  if (!candidate) {
    return { ok: false, status: 403, body: { success: false, code: "PAYOUT_OTP_REQUIRED", message: "Enter the verification code we emailed you to change payout details." } };
  }
  const record = await prisma.emailOTP.findFirst({
    where: { userId, purpose: PAYOUT_OTP_PURPOSE, verified: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  const invalid = { ok: false, status: 403, body: { success: false, code: "PAYOUT_OTP_INVALID", message: "The verification code is wrong or has expired." } };
  if (!record) return invalid;
  const result = await consumeOtpAttempt(prisma.emailOTP, record, candidate);
  if (!result.ok) return invalid;
  // Single use, atomically: two concurrent profile PUTs with the same code
  // must not both pass. Only the request that flips verified=false->true wins.
  if (!(await claimOtp(prisma.emailOTP, record.id))) return invalid;
  await prisma.emailOTP.deleteMany({ where: { userId, purpose: PAYOUT_OTP_PURPOSE } });
  return { ok: true, changed: true };
};

/** Email + push/in-app alert after a payout account change. Never throws. */
export const notifyPayoutAccountChanged = async (userId) => {
  try {
    const notice = renderNotification(NOTIFICATION_TYPES.PAYOUT_ACCOUNT_CHANGED);
    await createNotification(userId, notice.title, notice.body, { type: notice.type, data: notice.data });
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (user?.email) await sendEmail(user.email, `Keplix: ${notice.title}`, notice.body);
  } catch (err) {
    Logger.error(`[PayoutChange] alert failed for vendor ${userId}: ${err.message}`);
  }
};

// @route POST /accounts/vendor/profile/payout-otp  (protect, vendorOnly)
export const requestPayoutOtp = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, email: true } });
    if (!user?.email) return res.status(400).json({ success: false, message: "No email on this account" });
    const otp = generateOTP();
    await prisma.emailOTP.deleteMany({ where: { userId: user.id, purpose: PAYOUT_OTP_PURPOSE } });
    await prisma.emailOTP.create({
      data: {
        email: user.email.toLowerCase(),
        otp: hashOTP(otp),
        expiresAt: new Date(Date.now() + PAYOUT_OTP_TTL_MS),
        verified: false,
        purpose: PAYOUT_OTP_PURPOSE,
        userId: user.id,
      },
    });
    await sendEmail(
      user.email,
      "Your Keplix payout change code",
      `Your code to change your Keplix payout details is ${otp}. It expires in 10 minutes. If you did not ask for this, contact support.`,
      otpEmailTemplate({ otp })
    );
    return res.json({ success: true, message: "A verification code has been sent to your account email." });
  } catch (err) {
    console.error("requestPayoutOtp error:", err);
    return res.status(500).json({ success: false, message: "Failed to send code" });
  }
};
