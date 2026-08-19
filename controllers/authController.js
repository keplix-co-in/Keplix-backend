import prisma from "../util/prisma.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createRequire } from "module";
import admin from "../util/firebase.js"; // Use shared instance
import crypto from "crypto";
import { resend } from "../util/resend.js";
import { generateOTP } from "../util/otp.js";
import { otpEmailTemplate } from "../util/emailTemplate.js";
import { getISTDate } from "../util/time.js";
import { sendEmail, sendSMS } from "../util/communication.js";
import { normalizeIndianPhone } from "../util/phone.js";
import { blacklistToken, isRefreshTokenBlacklisted } from "../middleware/authMiddleware.js";
import { OAuth2Client } from "google-auth-library";

const require = createRequire(import.meta.url);

const JWT_SECRET = process.env.JWT_SECRET;
// Refresh tokens are signed with their own secret so a leaked access-token
// secret alone can't be used to forge a long-lived refresh token, and vice
// versa. Falls back to JWT_SECRET only outside production so local/dev
// setups that haven't set it yet don't break.
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET;

if (!JWT_SECRET) {
  const errorMsg = 'JWT_SECRET environment variable is required';
  console.error(errorMsg);
  if (process.env.NODE_ENV === 'production') {
    throw new Error(errorMsg);
  } else {
    console.warn('Using fallback JWT_SECRET for development');
  }
}

if (!process.env.JWT_REFRESH_SECRET) {
  const errorMsg = 'JWT_REFRESH_SECRET environment variable is required';
  console.error(errorMsg);
  if (process.env.NODE_ENV === 'production') {
    throw new Error(errorMsg);
  } else {
    console.warn('Using JWT_SECRET as a fallback JWT_REFRESH_SECRET for development');
  }
}

const generateAccessToken = (id) => {
  return jwt.sign({ id, type: 'access' }, JWT_SECRET, {
    expiresIn: "1d",
  });
};

const generateRefreshToken = (id) => {
  return jwt.sign({ id, type: 'refresh' }, JWT_REFRESH_SECRET, {
    expiresIn: "30d",
  });
};

// Alias for backward-compat usage (e.g. token refresh endpoint)
const generateToken = generateAccessToken;

const verifyDjangoPassword = (password, hash) => {
  try {
    const parts = hash.split("$");
    if (parts.length !== 4) return false;

    const [algorithm, iterations, salt, storedHash] = parts;
    if (algorithm !== "pbkdf2_sha256") return false;

    const keyLen = 32; // SHA256 produces 32 bytes
    const derivedKey = crypto.pbkdf2Sync(
      password,
      salt,
      parseInt(iterations),
      keyLen,
      "sha256",
    );
    const derivedHash = derivedKey.toString("base64");

    // timingSafeEqual, not === : a plain string compare short-circuits on the
    // first differing byte, so response time leaks how much of the hash was
    // guessed correctly. timingSafeEqual requires equal lengths, so compare
    // lengths first (that check is not itself secret — hash length is fixed by
    // the algorithm).
    const a = Buffer.from(derivedHash, "utf8");
    const b = Buffer.from(storedHash, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    console.error("Error verifying Django password:", e);
    return false;
  }
};

// @desc    Register a new user
// @route   POST /accounts/auth/signup/
// @access  Public
export const registerUser = async (req, res, next) => {
  const { email, password, role } = req.body;

  try {
    const userExists = await prisma.user.findUnique({
      where: { email },
    });

    if (userExists) {
      return res.status(400).json({
        success: false,
        error: "User already exists with this email.",
        code: "USER_EXISTS",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create User
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        role: role || "user",
      },
    });

    res.status(201).json({
      success: true,
      message: "Account created. Please verify your email to continue.",
      id: user.id,
      email: user.email,
      role: user.role,
      code: "PENDING_VERIFICATION",
    });
  } catch (error) {
    console.error(error);
    res.status(500);
    next(error);
  }
};

// @desc    Auth user & get token
// @route   POST /accounts/auth/login/
// @access  Public
export const authUser = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        userProfile: true,
        vendorProfile: true,
      },
    });

    if (user) {
      let isValid = false;

      // Social-only accounts are created with an empty password (the column is
      // non-nullable, so "" stands in for "no password set"). bcrypt.compare
      // against "" already returns false, but relying on that is one refactor
      // away from being a login bypass — reject explicitly instead, and don't
      // let an empty submitted password reach the comparison either.
      if (!user.password || !password) {
        return res.status(401).json({
          message: "Invalid email or password. If you signed up with Google, use Continue with Google.",
        });
      }

      // Check if it's a Django PBKDF2 hash
      if (user.password.startsWith("pbkdf2_sha256$")) {
        isValid = verifyDjangoPassword(password, user.password);
      } else {
        // Otherwise assume bcrypt (new users or dummy data)
        isValid = await bcrypt.compare(password, user.password);
      }

      if (isValid) {
        let profileData = {};
        if (user.role === "vendor" && user.vendorProfile) {
          profileData = {
            name: user.vendorProfile.business_name,
            phone: user.vendorProfile.phone,
            phone_number: user.vendorProfile.phone,
            address: user.vendorProfile.address || "",
            // Add other vendor fields if needed
            business_name: user.vendorProfile.business_name,
            profile_picture: user.vendorProfile.image,
            cover_image: user.vendorProfile.cover_image, // Add this!
            image: user.vendorProfile.image, // Ensure raw field is also there
          };
        } else if (user.userProfile) {
          profileData = {
            name: user.userProfile.name,
            phone: user.userProfile.phone,
            phone_number: user.userProfile.phone,
            address: user.userProfile.address || "",
            profile_picture: user.userProfile.profile_picture,
          };
        }

          const hasProfile = user.userProfile || user.vendorProfile;
          
          if (hasProfile && !user.is_verified) {
             // Treat legacy users with profiles as verified
             user.is_verified = true;
             await prisma.user.update({
               where: { id: user.id },
               data: { is_verified: true }
             });
          }

          const userData = {
            id: user.id,
            email: user.email,
            role: user.role,
            is_active: user.is_active,
            is_verified: user.is_verified,
            ...profileData,
          };

          if (!user.is_verified && !hasProfile) {
            return res.status(403).json({
              success: false,
              message: "Account not verified. Please verify your email or phone.",
              user: userData,
              code: "UNVERIFIED"
            });
          }        return res.json({
          user: userData,
          access: generateAccessToken(user.id),
          refresh: generateRefreshToken(user.id),
        });
      }
    }

    res.status(401).json({ message: "Invalid email or password" });
  } catch (error) {
    console.error(error);

    if (error.code === 'P2022') {
      return res.status(500).json({
        message: "Database schema is out of sync. Please update the backend database and try again.",
        code: "DATABASE_SCHEMA_MISMATCH",
      });
    }

    res.status(500).json({ message: "Server Error" });
  }
};

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
        id_proof_front: user.userProfile.id_proof_front,
        id_proof_back: user.userProfile.id_proof_back,
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

// @desc    Refresh Token
// @route   POST /accounts/auth/token/refresh/
export const refreshToken = async (req, res) => {
  const { refresh } = req.body;
  if (!refresh)
    return res.status(400).json({ message: "Refresh token required" });

  try {
    const blacklisted = await isRefreshTokenBlacklisted(refresh);
    if (blacklisted) {
      return res.status(401).json({ message: "Refresh token has been revoked" });
    }

    const decoded = jwt.verify(refresh, JWT_REFRESH_SECRET);
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });

    if (!user) return res.status(401).json({ message: "User not found" });

    // Rotate: the presented refresh token is single-use — blacklist it and
    // issue a new one, so a token that leaks (e.g. via logs, XSS) has a
    // limited window before it's replaced, and reuse of an old token after
    // rotation is detectable/rejected.
    await blacklistToken(refresh, decoded.exp);

    res.json({
      access: generateToken(user.id),
      refresh: generateRefreshToken(user.id),
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    res.status(401).json({ message: "Invalid refresh token" });
  }
};

// @desc    Logout user
// @route   POST /accounts/auth/logout/
export const logoutUser = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(400).json({ message: "Token missing" });
    }

    const decoded = jwt.decode(token);

    await blacklistToken(token, decoded.exp);
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Logout failed" });
  }
};

// @desc    Forgot Password
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    // Security: If the email does not exist, do not reveal this information, reply with success message
    if (!user) {
      return res.json({
        message: "If the email exists, a reset link has been sent.",
      });
    }

    // In real implementation, generate token and send email

    const resetToken = crypto.randomBytes(32).toString("hex");

    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    // save token for expiry ( 15 minutes )
    await prisma.user.update({
      where: { email },
      data: {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // create reset link
    const resetLink = `${process.env.FRONTEND_URL}/reset-password/${user.id}/${resetToken}`;

    // send email via Resend

    await sendEmail(
      email,
      "Reset Your Password",
      `Click here to reset your password: ${resetLink}`,
    );

    res.json({ message: "Password Reset Link Sent Successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Reset Password
export const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password, re_password } = req.body;

    if (password !== re_password) {
      return res.status(400).json({ message: "Password does not match" });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or Expired reset token" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });

    return res.json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Reset Password Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Send OTP for password reset (reuses EmailOTP infra, separate from
//          the token-link forgotPassword/resetPassword flow above — this
//          powers the OTP-based reset UX used by the vendor app)
export const sendPasswordResetOTP = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    // Security: don't reveal whether the email exists.
    if (!user) {
      return res.json({
        success: true,
        message: "If the email exists, a verification code has been sent.",
      });
    }

    const otp = generateOTP();
    const istNow = getISTDate();
    const expiresAt = new Date(istNow.getTime() + 10 * 60 * 1000); // 10 minutes

    // Delete any existing unverified reset OTPs for this email first.
    await prisma.emailOTP.deleteMany({
      where: { email: normalizedEmail, verified: false },
    });

    const record = await prisma.emailOTP.create({
      data: { email: normalizedEmail, otp, expiresAt, verified: false },
    });

    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "Keplix <noreply@keplix.co.in>",
        to: email,
        subject: "Your Keplix Password Reset Code",
        html: otpEmailTemplate({ otp }),
      });
    } catch (emailError) {
      console.error("sendPasswordResetOTP: Resend error:", emailError);
      // Still respond success — the OTP record exists and can be verified;
      // avoid leaking provider-level failures to the client.
    }

    return res.json({
      success: true,
      message: "If the email exists, a verification code has been sent.",
      otpId: record.id,
    });
  } catch (error) {
    console.error("sendPasswordResetOTP error:", error);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
};

// @desc    Verify OTP and set a new password in one step
export const resetPasswordWithOTP = async (req, res) => {
  try {
    const { email, otp, password } = req.body;
    if (!email || !otp || !password) {
      return res.status(400).json({ message: "Email, OTP, and new password are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedOtp = String(otp).trim();

    const record = await prisma.emailOTP.findFirst({
      where: { email: normalizedEmail },
      orderBy: { createdAt: "desc" },
    });

    if (!record) {
      return res.status(400).json({ message: "No verification code found for this email" });
    }
    if (record.verified) {
      return res.status(400).json({ message: "This verification code has already been used" });
    }
    if (new Date() > record.expiresAt) {
      return res.status(400).json({ message: "Verification code has expired" });
    }
    if (record.otp !== normalizedOtp) {
      return res.status(400).json({ message: "Invalid verification code" });
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword },
      }),
      prisma.emailOTP.update({
        where: { id: record.id },
        data: { verified: true },
      }),
    ]);

    return res.json({ success: true, message: "Password reset successfully" });
  } catch (error) {
    console.error("resetPasswordWithOTP error:", error);
    res.status(500).json({ success: false, message: "Server Error" });
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

    // Save OTP in database
    await prisma.phoneOTP.upsert({
      where: { phone_number },
      update: {
        otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        verified: false,
      },
      create: {
        phone_number,
        otp,
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

    if (otpRecord.otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    // Mark as verified
    await prisma.phoneOTP.update({
      where: { phone_number },
      data: { verified: true },
    });

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
    console.error("verifyPhoneOTP error:", error);
    res
      .status(500)
      .json({ error: "Failed to verify OTP", details: error.message });
  }
};

export const sendEmailOTP = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const otp = generateOTP();

    const istNow = getISTDate();
    const expiresAt = new Date(istNow.getTime() + 2 * 60 * 1000); // 2 minutes

    // Delete any existing unverified OTPs for this email first
    await prisma.emailOTP.deleteMany({
      where: {
        email: normalizedEmail,
        verified: false,
      },
    });

    // Create NEW OTP record
    const record = await prisma.emailOTP.create({
      data: {
        email: normalizedEmail,
        otp,
        expiresAt,
        verified: false,
      },
    });

    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "Keplix <noreply@keplix.co.in>",
        to: email,
        subject: "Your Keplix Verification Code",
        html: otpEmailTemplate({ otp }),
      });

      return res.json({
        success: true,
        message: "OTP sent successfully (valid for 2 minutes)",
        otpId: record.id,
      });
    } catch (emailError) {
      console.error("Resend error:", emailError);

      return res.json({
        success: true,
        message: "OTP generated but email service failed",
        otpId: record.id,
        otp: process.env.NODE_ENV === "development" ? otp : undefined,
        warning: "Email provider issue",
      });
    }
  } catch (error) {
    console.error("sendEmailOTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to send OTP",
    });
  }
};

export const verifyEmailOTP = async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: "Email and OTP are required" });
  }

  try {
    // Normalize inputs
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedOtp = String(otp).trim();

    // Find the most recent OTP record for this email
    const record = await prisma.emailOTP.findFirst({
      where: { 
        email: normalizedEmail
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (!record) {
      return res.status(400).json({ error: "No OTP found for this email" });
    }

    if (record.verified) {
      return res.status(400).json({ error: "OTP already used" });
    }

    // Expiry check (before OTP comparison)
    if (new Date() > record.expiresAt) {
      return res.status(400).json({ error: "OTP has expired" });
    }

    if (record.otp !== normalizedOtp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    await prisma.emailOTP.update({
      where: { id: record.id },
      data: { verified: true },
    });

    // Mark user as verified
    await prisma.user.update({
      where: { email: record.email },
      data: { is_verified: true },
    });

    const verifiedUser = await prisma.user.findUnique({
      where: { email: record.email },
      include: {
        userProfile: true,
        vendorProfile: true,
      },
    });

    if (verifiedUser && verifiedUser.role === "vendor" && !verifiedUser.vendorProfile) {
      await prisma.vendorProfile.create({
        data: {
          userId: verifiedUser.id,
          business_name: verifiedUser.email.split("@")[0],
          phone: "",
          onboarding_completed: false,
        },
      });
    } else if (verifiedUser && verifiedUser.role !== "vendor" && !verifiedUser.userProfile) {
      await prisma.userProfile.create({
        data: {
          userId: verifiedUser.id,
          name: verifiedUser.email.split("@")[0],
          phone: "",
        },
      });
    }

    // Fetch user using email from DB (not from client)
    const user = await prisma.user.findUnique({
      where: { email: record.email },
      include: {
        userProfile: true,
        vendorProfile: true,
      },
    });

    if (!user) {
      return res.json({
        success: true,
        message: "Email OTP verified successfully",
      });
    }

    return res.json({
      success: true,
      message: "Email OTP verified successfully",
      access: generateAccessToken(user.id),
      refresh: generateRefreshToken(user.id),
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name:
          user.role === "vendor"
            ? user.vendorProfile?.business_name
            : user.userProfile?.name,
        phone:
          user.role === "vendor"
            ? user.vendorProfile?.phone
            : user.userProfile?.phone,
        is_active: user.is_active,
      },
    });
  } catch (error) {
    console.error("verifyEmailOTP error:", error);
    return res.status(500).json({ message: "OTP Verification Failed" });
  }
};

// Strict server-side whitelist for self-selectable signup roles.
// Defense-in-depth: enforced here independently of the Zod route validator,
// so a client-supplied role can never reach prisma.user.create() unvalidated.
const ALLOWED_SIGNUP_ROLES = ["user", "vendor"];

const googleOAuthClient = new OAuth2Client();

/**
 * OAuth client IDs whose ID tokens we accept.
 *
 * This is the security boundary for Google sign-in: a token is only ours if
 * its `aud` is one of these. It must list every client that legitimately signs
 * users in — the customer app and the vendor app, across the dev and prod
 * Firebase projects — hence a comma-separated env var rather than a constant.
 *
 * Read at call time, not at module load, so a deployment can rotate the list
 * without a code change.
 *
 * Throws when unset: an empty audience list would make verifyIdToken accept
 * ANY audience, silently restoring the very hole this replaced. Failing the
 * request is the safe direction.
 */
const getAllowedGoogleAudiences = () => {
  const raw = process.env.GOOGLE_ALLOWED_AUDIENCES || "";
  const audiences = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (audiences.length === 0) {
    throw new Error(
      "GOOGLE_ALLOWED_AUDIENCES is not set — refusing to verify Google tokens without an audience allowlist"
    );
  }
  return audiences;
};

// @desc    Google Login
export const googleLogin = async (req, res) => {
  const { idToken, role } = req.body;
  const safeRole = ALLOWED_SIGNUP_ROLES.includes(role) ? role : "user";

  try {
    // Verify the Google ID token properly.
    //
    // This previously fell back to GET /tokeninfo and checked only `iss` — i.e.
    // "was this issued by Google?" — but never `aud`, "was this issued to US?".
    // Because the apps send a raw Google ID token (not a Firebase one), the
    // Firebase branch above always threw and every request took that fallback.
    // The result was an account-takeover hole: an ID token minted for ANY
    // Google OAuth client on earth was accepted, and the lookup below links by
    // email alone, so anyone could obtain Keplix tokens for any account just by
    // knowing its email address.
    //
    // verifyIdToken checks the signature, expiry, issuer AND audience against
    // the allowlist, so a token minted for someone else's client is rejected.
    // Resolved BEFORE the try below so a misconfigured server surfaces as a
    // 500, not a 401. Telling a user "invalid token" when the real fault is a
    // missing env var sends them chasing their own credentials.
    let allowedAudiences;
    try {
      allowedAudiences = getAllowedGoogleAudiences();
    } catch (configError) {
      console.error("Google sign-in misconfigured:", configError.message);
      return res.status(500).json({ message: "Google sign-in is not configured on this server." });
    }

    let payload;
    try {
      const ticket = await googleOAuthClient.verifyIdToken({
        idToken,
        audience: allowedAudiences,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      console.error("Google ID token verification failed:", verifyError.message);
      return res.status(401).json({ message: "Invalid token" });
    }

    if (!payload?.email) {
      return res.status(401).json({ message: "Invalid token" });
    }

    // Google says it has not verified ownership of this address. Trusting it
    // would let someone register an unverified Google account on a victim's
    // address and be handed the victim's existing Keplix account by the lookup
    // below.
    if (payload.email_verified !== true) {
      return res.status(401).json({
        message: "Your Google account's email is not verified. Please verify it with Google and try again.",
      });
    }

    const email = payload.email;
    // Default name if missing
    const name = payload.name || email.split("@")[0];

    let user = await prisma.user.findUnique({
      where: { email },
      include: {
        userProfile: true,
        vendorProfile: true,
      }
    });

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      // Register new user
      user = await prisma.user.create({
        data: {
          email,
          password: "", // Social login has no password
          role: safeRole,
          is_active: true,
        },
      });

      // Create Profile
      if (safeRole === "vendor") {
        await prisma.vendorProfile.create({
          data: {
            userId: user.id,
            business_name: name,
            phone: "",
            onboarding_completed: false,
          },
        });
      } else {
        await prisma.userProfile.create({
          data: {
            userId: user.id,
            name: name,
            phone: "",
          },
        });
      }

      // Re-fetch user with profile
      user = await prisma.user.findUnique({
        where: { id: user.id },
        include: {
          userProfile: true,
          vendorProfile: true,
        }
      });
    }

    // A User row can exist WITHOUT its profile row. Profile creation above only
    // runs for brand-new users, so any account that reached this point missing
    // its profile — a partial signup, a failed profile insert, a user seeded by
    // another path — stayed broken forever: the response builder below is
    // guarded by `else if (user.userProfile)`, so it silently returned a
    // userData with no name, phone or picture, and getUserProfile did the same.
    // The app then showed a blank profile after signing in with Google.
    //
    // Two such accounts exist in the database today (ids 480 and 456), which is
    // how this was found.
    //
    // Create only what is missing. Never touch an existing profile here: this
    // path must not overwrite a name, phone or picture the user set during
    // onboarding with whatever Google reports.
    const needsUserProfile = user.role !== "vendor" && !user.userProfile;
    const needsVendorProfile = user.role === "vendor" && !user.vendorProfile;

    if (needsUserProfile || needsVendorProfile) {
      console.warn(
        `Google login: user ${user.id} (${user.email}) had no ${user.role === "vendor" ? "vendorProfile" : "userProfile"}; creating one.`
      );

      if (needsVendorProfile) {
        await prisma.vendorProfile.create({
          data: {
            userId: user.id,
            business_name: name,
            phone: "",
            onboarding_completed: false,
          },
        });
      } else {
        await prisma.userProfile.create({
          data: { userId: user.id, name, phone: "" },
        });
      }

      user = await prisma.user.findUnique({
        where: { id: user.id },
        include: { userProfile: true, vendorProfile: true },
      });
    }

    // Build response with profile data
    const userData = {
      id: user.id,
      email: user.email,
      role: user.role,
      is_active: user.is_active,
    };

    // phone_number mirrors phone throughout the API (see getUserProfile). The
    // apps read `phone_number` in places — components/Profile/UserProfile.jsx
    // populates its phone field from it — so omitting it here made the number
    // vanish after a Google sign-in even when the profile held one.
    if (user.role === "vendor" && user.vendorProfile) {
      userData.business_name = user.vendorProfile.business_name;
      userData.name = user.vendorProfile.business_name;
      userData.phone = user.vendorProfile.phone;
      userData.phone_number = user.vendorProfile.phone;
      userData.address = user.vendorProfile.address;
      userData.image = user.vendorProfile.image;
      userData.cover_image = user.vendorProfile.cover_image;
      userData.onboarding_completed = user.vendorProfile.onboarding_completed;
      userData.status = user.vendorProfile.status;
    } else if (user.userProfile) {
      userData.name = user.userProfile.name;
      userData.phone = user.userProfile.phone;
      userData.phone_number = user.userProfile.phone;
      userData.address = user.userProfile.address;
      userData.profile_picture = user.userProfile.profile_picture;
      userData.id_proof_front = user.userProfile.id_proof_front;
      userData.id_proof_back = user.userProfile.id_proof_back;
    }

    res.json({
      access: generateAccessToken(user.id),
      refresh: generateRefreshToken(user.id),
      user: userData,
      isNewUser: isNewUser
    });
  } catch (error) {
    console.error("Google Login Error:", error);
    res.status(401).json({ message: "Invalid token" });
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

    // 1. Check if email is being changed and if it's already taken
    if (email && email !== req.user.email) {
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });
      if (existingUser) {
        return res.status(400).json({
          message: "Email already in use by another account",
        });
      }
    }

    // 2. Update User (email)
    const userUpdateData = {};
    if (email && email !== req.user.email) {
      userUpdateData.email = email;
    }

    if (Object.keys(userUpdateData).length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: userUpdateData,
      });
    }

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

    // Use uploaded files if available, otherwise use the URLs from body
    if (uploadedProfilePicture) {
      profileUpdateData.profile_picture = uploadedProfilePicture;
    } else if (profile_picture !== undefined && profile_picture !== null) {
      profileUpdateData.profile_picture = profile_picture;
    }

    if (uploadedIdFront) {
      profileUpdateData.id_proof_front = uploadedIdFront;
    } else if (id_proof_front !== undefined && id_proof_front !== null) {
      profileUpdateData.id_proof_front = id_proof_front;
    }

    if (uploadedIdBack) {
      profileUpdateData.id_proof_back = uploadedIdBack;
    } else if (id_proof_back !== undefined && id_proof_back !== null) {
      profileUpdateData.id_proof_back = id_proof_back;
    }

    const profile = await prisma.userProfile.upsert({
      where: { userId: userId },
      update: profileUpdateData,
      create: {
        userId: userId,
        name: name || "User",
        phone: finalPhone || null,
        address: address || null,
        profile_picture: uploadedProfilePicture || profile_picture || null,
        id_proof_front: uploadedIdFront || id_proof_front || null,
        id_proof_back: uploadedIdBack || id_proof_back || null,
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
        id_proof_front: updatedUser.userProfile.id_proof_front,
        id_proof_back: updatedUser.userProfile.id_proof_back,
      };
    }

    res.json({
      id: updatedUser.id,
      email: updatedUser.email,
      roles: updatedUser.role,
      ...profileData,
      debug_upload: {
        files_received: req.files ? Object.keys(req.files) : "No req.files",
        profile_picture_file: !!req.files?.profile_picture,
        body_keys: Object.keys(req.body),
      },
    });
  } catch (error) {
    console.error("updateUserProfileAuth error:", error);
    res.status(500).json({
      message: "Failed to update profile",
      error: error.message,
    });
  }
};
// Update push token for logged in user
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
    res.status(500).json({ success: false, error: error.message });
  }
};
// ======================
// keplix-backend/authController.js
// ======================

