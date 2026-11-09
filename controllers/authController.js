import prisma from "../util/prisma.js";
import {
  generateOTP,
  hashOTP,
  consumeOtpAttempt,
  claimOtp,
  OTP_TOO_MANY_ATTEMPTS_MESSAGE,
} from "../util/otp.js";
import { otpEmailTemplate } from "../util/emailTemplate.js";
import { sendEmail, sendSMS } from "../util/communication.js";
import { normalizeIndianPhone } from "../util/phone.js";
import { eraseUserPii } from "../services/accountErasureService.js";
import { getUserDataExport } from "../services/accountExportService.js";
import { isAllowedPushEndpoint } from "../util/webPush.js";
import { acceptOwnCloudinaryUrl, signPrivateUrl } from "../util/cloudinary.js";
import { updateSupabaseUserEmail, deleteSupabaseUser } from "../util/supabaseAuth.js";

// 2026-11 Supabase migration: sign-in, sign-up, password reset/change, Google
// login and token refresh moved to Supabase Auth (see supabaseAuthController.js
// and util/supabaseAuth.js). Passwords are no longer stored or checked here.


// @desc    Get user profile
// @route   GET /accounts/auth/profile/
// @access  Private
export const getUserProfile = async (req, res) => {
  const user = req.user;

  if (user) {
    let profileData = {};
    if (user.role === "vendor" && user.vendorProfile) {
      profileData = {
        name: user.vendorProfile.business_name,
        phone: user.vendorProfile.phone,
        phone_number: user.vendorProfile.phone, // For frontend compatibility
        ...user.vendorProfile,
      };
    } else if (user.userProfile) {
      profileData = {
        name: user.userProfile.name,
        phone: user.userProfile.phone,
        phone_number: user.userProfile.phone, // For frontend compatibility
        address: user.userProfile.address,
        profile_picture: user.userProfile.profile_picture,
        // Security A-015: ID proofs are private assets; the owner gets a
        // short-lived signed URL (legacy public URLs pass through unchanged).
        id_proof_front: signPrivateUrl(user.userProfile.id_proof_front),
        id_proof_back: signPrivateUrl(user.userProfile.id_proof_back),
      };
    }

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      ...profileData,
    });
  } else {
    res.status(404).json({ message: "User not found" });
  }
};
// @desc    Send Phone OTP
export const sendPhoneOTP = async (req, res) => {
  const { phone_number: rawPhoneNumber } = req.body;

  if (!rawPhoneNumber) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  // Normalised here so PhoneOTP is keyed identically to how the walk-in
  // job / vehicle / claim flows store phones. Previously this column held
  // whatever the client sent, so "9876543210" and "+919876543210" were two
  // different OTP records — verifying with the other form always failed.
  const phone_number = normalizeIndianPhone(rawPhoneNumber);
  if (!phone_number) {
    return res.status(400).json({ error: "Invalid Indian mobile number" });
  }

  try {
    const otp = generateOTP();

    // Save OTP in database. Security O-005: only the HMAC is stored; a new
    // code also resets the O-001 attempt counter.
    const otpHash = hashOTP(otp);
    await prisma.phoneOTP.upsert({
      where: { phone_number },
      update: {
        otp: otpHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        verified: false,
        failedAttempts: 0,
      },
      create: {
        phone_number,
        otp: otpHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        verified: false,
      },
    });

    // Send SMS
    const smsMessage = `Your Keplix verification code is: ${otp}. Valid for 10 minutes.`;
    const smsSent = await sendSMS(phone_number, smsMessage);

    if (smsSent) {
      res.json({ status: true, message: "Phone OTP sent successfully" });
    } else {
      // SMS service not configured, return OTP in development
      res.json({
        status: true,
        message: "OTP generated (SMS Service Unavailable)",
        otp: process.env.NODE_ENV === "development" ? otp : undefined,
        warning: "SMS service not configured. Use the code from logs.",
      });
    }
  } catch (error) {
    console.error("sendPhoneOTP error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
};

// @desc    Verify Phone OTP
export const verifyPhoneOTP = async (req, res) => {
  const { phone_number: rawPhoneNumber, otp } = req.body;

  if (!rawPhoneNumber || !otp) {
    return res.status(400).json({ error: "Phone number and OTP are required" });
  }

  // Must match the normalisation applied in sendPhoneOTP, or a correctly
  // entered number in a different format will never find its OTP row.
  const phone_number = normalizeIndianPhone(rawPhoneNumber);
  if (!phone_number) {
    return res.status(400).json({ error: "Invalid Indian mobile number" });
  }

  try {
    const otpRecord = await prisma.phoneOTP.findUnique({
      where: { phone_number },
    });

    if (!otpRecord) {
      return res
        .status(400)
        .json({ error: "No OTP found for this phone number" });
    }

    if (otpRecord.verified) {
      return res.status(400).json({ error: "OTP already verified" });
    }

    if (new Date() > otpRecord.expiresAt) {
      return res.status(400).json({ error: "OTP has expired" });
    }

    // Security O-001 / O-005: hashed, constant-time, max 5 guesses per code.
    const attempt = await consumeOtpAttempt(prisma.phoneOTP, otpRecord, String(otp).trim());
    if (!attempt.ok) {
      return res.status(400).json(
        attempt.locked
          ? { error: OTP_TOO_MANY_ATTEMPTS_MESSAGE, code: "OTP_ATTEMPTS_EXCEEDED" }
          : { error: "Invalid OTP", code: "OTP_INVALID" }
      );
    }

    // Mark as verified
    // Atomic single-use: only one concurrent request can flip verified.
    if (!(await claimOtp(prisma.phoneOTP, otpRecord.id))) {
      return res.status(400).json({ error: "OTP already verified" });
    }

    // Also mark the user as verified.
    // NOTE: phone_number is now normalised (+91XXXXXXXXXX), but
    // UserProfile.phone / VendorProfile.phone are free text and may still
    // hold whatever format a profile form originally sent (bare 10-digit,
    // spaces, etc). This match was already an exact string comparison before
    // this change — normalising phone_number does not make it more fragile,
    // but it does mean a profile phone stored in a different format than the
    // OTP will not match here. Fixing that needs a backfill of
    // UserProfile/VendorProfile.phone through normalizeIndianPhone, which is
    // a separate, data-touching change and out of scope here.
    const matchedUsers = await prisma.user.findMany({
      where: {
        OR: [
          { userProfile: { phone: phone_number } },
          { vendorProfile: { phone: phone_number } }
        ]
      },
      include: {
        userProfile: true,
        vendorProfile: true,
      },
    });

    for (const matchedUser of matchedUsers) {
      await prisma.user.update({
        where: { id: matchedUser.id },
        data: { is_verified: true },
      });

      if (matchedUser.role === "vendor" && !matchedUser.vendorProfile) {
        await prisma.vendorProfile.create({
          data: {
            userId: matchedUser.id,
            business_name: matchedUser.email.split("@")[0],
            phone: phone_number,
            onboarding_completed: false,
          },
        });
      } else if (matchedUser.role !== "vendor" && !matchedUser.userProfile) {
        await prisma.userProfile.create({
          data: {
            userId: matchedUser.id,
            name: matchedUser.email.split("@")[0],
            phone: phone_number,
          },
        });
      }
    }

    res.json({ status: true, message: "Phone OTP verified successfully" });
  } catch (error) {
    // Security A-008: error.message is logged, never returned to the client.
    console.error("verifyPhoneOTP error:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
};

// @desc    Update user profile
// @route   PUT /accounts/auth/profile/
// @access  Private
export const updateUserProfileAuth = async (req, res) => {
  const userId = req.user.id;
  const {
    name,
    email,
    phone_number,
    phone,
    address,
    profile_picture,
    id_proof_front,
    id_proof_back,
  } = req.body;

  try {
    // The Cloudinary URL lives at file.cloudinary.secure_url, NOT file.path.
    //
    // uploadFieldss (middleware/uploadMiddleware.js) uses multer.memoryStorage()
    // and streams the buffer to Cloudinary itself, attaching the API result at
    // file.cloudinary. Memory storage never sets `path` -- that only exists with
    // diskStorage or multer-storage-cloudinary.
    //
    // So these three were always undefined. The upload genuinely succeeded, the
    // file reached Cloudinary, and req.files was populated -- the debug_upload
    // block below happily reported files_received: ["profile_picture"] -- but
    // the value written to the database fell through to the `profile_picture`
    // body field, which a multipart upload does not send. Every profile image
    // saved as null, and the apps showed their placeholder avatar forever.
    //
    // See controllers/vendor/serviceController.js:32 for the same fix.
    const uploadedProfilePicture = req.files?.profile_picture?.[0]?.cloudinary?.secure_url;
    const uploadedIdFront = req.files?.id_proof_front?.[0]?.cloudinary?.secure_url;
    const uploadedIdBack = req.files?.id_proof_back?.[0]?.cloudinary?.secure_url;

    // Security A-005: the email is the login AND the password-reset channel,
    // so a hijacked session could swap it and take the account over for good.
    // This endpoint no longer writes it. A changed email is ignored here and
    // the response says `email_change_required: true`; the client must use
    // POST /accounts/auth/email-change/request then /email-change/verify
    // (OTP to the NEW address; the old address is told afterwards).
    const emailChangeRequested =
      typeof email === "string" &&
      email.trim() !== "" &&
      email.trim().toLowerCase() !== String(req.user.email || "").toLowerCase();

    // 3. Update UserProfile (name, phone, address, images)
    // Map phone_number from frontend to phone in backend if needed
    const finalPhone = phone || phone_number;

    // Build update data - only include fields that are provided
    const profileUpdateData = {};
    if (name !== undefined && name !== null) profileUpdateData.name = name;
    if (finalPhone !== undefined && finalPhone !== null)
      profileUpdateData.phone = finalPhone;
    if (address !== undefined && address !== null)
      profileUpdateData.address = address;

    // Use uploaded files if available, otherwise use the URLs from body.
    // Security A-014: a body URL is only accepted if it is one of OUR
    // Cloudinary assets (or '' / null to clear); anything else is ignored, so
    // a client can't point a profile at an arbitrary/tracking/malicious URL.
    const bodyProfilePicture = acceptOwnCloudinaryUrl(profile_picture);
    const bodyIdFront = acceptOwnCloudinaryUrl(id_proof_front);
    const bodyIdBack = acceptOwnCloudinaryUrl(id_proof_back);

    if (uploadedProfilePicture) {
      profileUpdateData.profile_picture = uploadedProfilePicture;
    } else if (bodyProfilePicture !== undefined) {
      profileUpdateData.profile_picture = bodyProfilePicture;
    }

    if (uploadedIdFront) {
      profileUpdateData.id_proof_front = uploadedIdFront;
    } else if (bodyIdFront !== undefined) {
      profileUpdateData.id_proof_front = bodyIdFront;
    }

    if (uploadedIdBack) {
      profileUpdateData.id_proof_back = uploadedIdBack;
    } else if (bodyIdBack !== undefined) {
      profileUpdateData.id_proof_back = bodyIdBack;
    }

    const profile = await prisma.userProfile.upsert({
      where: { userId: userId },
      update: profileUpdateData,
      create: {
        userId: userId,
        name: name || "User",
        phone: finalPhone || null,
        address: address || null,
        profile_picture: uploadedProfilePicture || bodyProfilePicture || null,
        id_proof_front: uploadedIdFront || bodyIdFront || null,
        id_proof_back: uploadedIdBack || bodyIdBack || null,
      },
    });

    // 4. Return updated profile data (matching getUserProfile format)
    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        userProfile: true,
        vendorProfile: true,
      },
    });

    // Return profile based on role
    let profileData = {};
    if (updatedUser.role === "vendor" && updatedUser.vendorProfile) {
      profileData = {
        name: updatedUser.vendorProfile.business_name,
        phone: updatedUser.vendorProfile.phone,
        phone_number: updatedUser.vendorProfile.phone,
        ...updatedUser.vendorProfile,
      };
    } else if (updatedUser.userProfile) {
      profileData = {
        name: updatedUser.userProfile.name,
        phone: updatedUser.userProfile.phone,
        phone_number: updatedUser.userProfile.phone,
        address: updatedUser.userProfile.address,
        profile_picture: updatedUser.userProfile.profile_picture,
        id_proof_front: signPrivateUrl(updatedUser.userProfile.id_proof_front),
        id_proof_back: signPrivateUrl(updatedUser.userProfile.id_proof_back),
      };
    }

    // debug_upload (request body keys, file names) was removed: it echoed
    // request internals back to every client.
    res.json({
      id: updatedUser.id,
      email: updatedUser.email,
      roles: updatedUser.role,
      ...profileData,
      ...(emailChangeRequested ? { email_change_required: true } : {}),
    });
  } catch (error) {
    console.error("updateUserProfileAuth error:", error);
    // Security A-008: error.message (Prisma/driver/gateway internals) is logged, never returned.
    res.status(500).json({
      message: "Failed to update profile",
    });
  }
};
// ---------------------------------------------------------------------------
// Security A-005: email change is a two-step, OTP-verified flow.
//
//   POST /accounts/auth/email-change/request  { new_email }
//     -> 200 { success:true, message }  code emailed to new_email (10 min)
//     -> 400 { message }                invalid / same as current / in use
//   POST /accounts/auth/email-change/verify   { new_email, otp }
//     -> 200 { success:true, email }    email swapped, old address notified
//     -> 400 { code:'OTP_INVALID' | 'OTP_ATTEMPTS_EXCEEDED', message }
//     -> 409 { message }                taken in the meantime
// ---------------------------------------------------------------------------
const EMAIL_CHANGE_PURPOSE = "email_change";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const requestEmailChange = async (req, res) => {
  try {
    const newEmail = String(req.body?.new_email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(newEmail) || newEmail.length > 254) {
      return res.status(400).json({ success: false, message: "Enter a valid email address" });
    }
    if (newEmail === String(req.user.email || "").toLowerCase()) {
      return res.status(400).json({ success: false, message: "That is already your email" });
    }
    const existing = await prisma.user.findUnique({ where: { email: newEmail } });
    if (existing) {
      // Same wording the profile endpoint has always used for this case.
      return res.status(400).json({ success: false, message: "Email already in use by another account" });
    }

    const otp = generateOTP();
    await prisma.emailOTP.deleteMany({ where: { userId: req.user.id, purpose: EMAIL_CHANGE_PURPOSE } });
    await prisma.emailOTP.create({
      data: {
        email: newEmail,
        otp: hashOTP(otp),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        verified: false,
        purpose: EMAIL_CHANGE_PURPOSE,
        userId: req.user.id,
      },
    });
    await sendEmail(
      newEmail,
      "Confirm your new Keplix email",
      `Your code to confirm this email for your Keplix account is ${otp}. It expires in 10 minutes.`,
      otpEmailTemplate({ otp })
    );
    return res.json({ success: true, message: "A verification code has been sent to the new email." });
  } catch (error) {
    console.error("requestEmailChange error:", error);
    return res.status(500).json({ success: false, message: "Failed to start email change" });
  }
};

export const verifyEmailChange = async (req, res) => {
  try {
    const newEmail = String(req.body?.new_email || "").trim().toLowerCase();
    const otp = String(req.body?.otp || "").trim();
    const invalid = { success: false, code: "OTP_INVALID", message: "Invalid or expired code" };
    if (!newEmail || !otp) return res.status(400).json(invalid);

    const record = await prisma.emailOTP.findFirst({
      where: {
        userId: req.user.id,
        purpose: EMAIL_CHANGE_PURPOSE,
        email: newEmail,
        verified: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!record) return res.status(400).json(invalid);

    const result = await consumeOtpAttempt(prisma.emailOTP, record, otp);
    if (!result.ok) {
      return res.status(400).json(
        result.locked
          ? { success: false, code: "OTP_ATTEMPTS_EXCEEDED", message: OTP_TOO_MANY_ATTEMPTS_MESSAGE }
          : invalid
      );
    }
    // Atomic single-use so two concurrent requests can't both redeem the code.
    if (!(await claimOtp(prisma.emailOTP, record.id))) return res.status(400).json(invalid);

    const oldEmail = req.user.email;
    // Supabase is where the user signs in, so its email must move too --
    // otherwise they would keep logging in with the old address. Done first:
    // if Supabase refuses (address taken there), nothing changes in Prisma.
    if (req.user.supabaseId) {
      try {
        await updateSupabaseUserEmail(req.user.supabaseId, newEmail);
      } catch (err) {
        console.error("verifyEmailChange: Supabase email update failed:", err?.message);
        return res.status(409).json({ success: false, message: "Email already in use by another account" });
      }
    }
    try {
      await prisma.user.update({ where: { id: req.user.id }, data: { email: newEmail } });
    } catch (err) {
      if (err?.code === "P2002") {
        return res.status(409).json({ success: false, message: "Email already in use by another account" });
      }
      throw err;
    }
    await prisma.emailOTP.deleteMany({ where: { userId: req.user.id, purpose: EMAIL_CHANGE_PURPOSE } });

    // Tell the OLD address, so a takeover attempt is visible to the owner.
    if (oldEmail) {
      try {
        await sendEmail(
          oldEmail,
          "Your Keplix email was changed",
          "The email on your Keplix account was just changed. If this was not you, contact Keplix support immediately."
        );
      } catch (e) {
        console.error("verifyEmailChange: old-address notice failed:", e?.message);
      }
    }
    return res.json({ success: true, email: newEmail });
  } catch (error) {
    console.error("verifyEmailChange error:", error);
    return res.status(500).json({ success: false, message: "Failed to change email" });
  }
};

// ======================
// Web Push subscriptions (vendor portal browser alerts) — see util/webPush.js
// ======================
const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER = 5;

export const registerWebPush = async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    const p256dh = keys?.p256dh;
    const auth = keys?.auth;

    if (!isAllowedPushEndpoint(endpoint)) {
      return res.status(400).json({ success: false, message: 'Unsupported push endpoint' });
    }
    if (
      typeof p256dh !== 'string' || p256dh.length === 0 || p256dh.length > 256 ||
      typeof auth !== 'string' || auth.length === 0 || auth.length > 256
    ) {
      return res.status(400).json({ success: false, message: 'Invalid push keys' });
    }

    const userId = req.user.id;
    const userAgent = String(req.get('user-agent') || '').slice(0, 300) || null;

    // Bound the table per user: one vendor with many browsers is normal, one
    // account registering thousands is not. Drop the oldest beyond the cap.
    const others = await prisma.webPushSubscription.findMany({
      where: { userId, NOT: { endpoint } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (others.length >= MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER) {
      const stale = others.slice(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER - 1).map((row) => row.id);
      await prisma.webPushSubscription.deleteMany({ where: { id: { in: stale } } });
    }

    // Upsert by endpoint: the same browser signing in as a different user moves
    // the subscription to that user instead of leaving it on the old one.
    await prisma.webPushSubscription.upsert({
      where: { endpoint },
      update: { userId, p256dh, auth, userAgent },
      create: { userId, endpoint, p256dh, auth, userAgent },
    });

    res.json({ success: true, message: 'Web push subscription saved' });
  } catch (error) {
    console.error('Register web push error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

export const unregisterWebPush = async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (typeof endpoint !== 'string' || !endpoint) {
      return res.status(400).json({ success: false, message: 'endpoint is required' });
    }
    // Scoped to the caller so one user cannot remove another's subscription.
    await prisma.webPushSubscription.deleteMany({ where: { endpoint, userId: req.user.id } });
    res.json({ success: true, message: 'Web push subscription removed' });
  } catch (error) {
    console.error('Unregister web push error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

export const updatePushToken = async (req, res) => {
  try {
    const { pushToken } = req.body;
    const userId = req.user.id; // Assuming auth middleware sets req.user

    await prisma.user.update({
      where: { id: userId },
      data: { pushToken }
    });

    res.json({ success: true, message: 'Push token updated' });
  } catch (error) {
    console.error('âŒ Update push token error:', error);
    // Security A-008: error.message (Prisma/driver/gateway internals) is logged, never returned.
    res.status(500).json({ success: false, error: 'Failed to update push token' });
  }
};
// ======================
// keplix-backend/authController.js
// ======================


// @desc    Erase the caller's own account (GDPR Art.17). Thin wrapper around
//          services/accountErasureService.js's eraseUserPii -- the actual
//          redaction logic lives there once, shared with
//          controllers/user/profileController.js's equivalent
//          :userId-scoped route. This one exists because the mobile app's
//          own profile calls (getProfile/updateProfile above) go through
//          /accounts/auth/profile, not /service_api/user/:userId/profile,
//          so a delete/export button in the app needs an equivalent route
//          in THIS family to actually be reachable from where the app
//          already authenticates.
// @route   DELETE /accounts/auth/account
export const deleteAccount = async (req, res) => {
  try {
    const result = await eraseUserPii(req.user.id, { io: req.app?.get?.("io") });
    // Remove the Supabase login too, so the erased email cannot sign back
    // into this (now inactive) row. Best effort: the row is already
    // deactivated, which `protect` enforces regardless.
    if (req.user.supabaseId) {
      try {
        await deleteSupabaseUser(req.user.supabaseId);
        await prisma.user.update({ where: { id: req.user.id }, data: { supabaseId: null } });
      } catch (e) {
        console.error("[Auth] Supabase user delete failed:", e?.message);
      }
    }
    res.json({
      message: "Account deactivated and personal data erased.",
      erasure: result,
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({ message: "User not found" });
    }
    console.error('[Auth] Account erasure error:', error.message);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Export the caller's own data (GDPR Art.15/Art.20). Thin wrapper
//          around services/accountExportService.js's getUserDataExport --
//          see deleteAccount above for why this route exists alongside the
//          :userId-scoped one in controllers/user/profileController.js.
// @route   GET /accounts/auth/export
export const exportAccountData = async (req, res) => {
  try {
    const bundle = await getUserDataExport(req.user.id);
    if (!bundle) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(bundle);
  } catch (error) {
    console.error('[Auth] Data export error:', error.message);
    res.status(500).json({ message: "Server Error" });
  }
};
