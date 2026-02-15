import prisma from 'file:///C:/keplix-frontend-master/keplix-backend/util/prisma.js';
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createRequire } from "module";
import admin from "../util/firebase.js"; // Use shared instance
import crypto from "crypto";
import { resend } from "../util/resend.js";
import { generateOTP } from "../util/otp.js";
import { otpEmailTemplate } from "../util/emailTemplate.js";
import { getISTDate } from "../util/time.js";

const require = createRequire(import.meta.url);

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  const errorMsg = 'JWT_SECRET environment variable is required';
  console.error(errorMsg);
  if (process.env.NODE_ENV === 'production') {
    throw new Error(errorMsg);
  } else {
    console.warn('Using fallback JWT_SECRET for development');
  }
}

const generateToken = (id) => {
  return jwt.sign({ id }, JWT_SECRET, {
    expiresIn: "30d",
  });
};

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

    return derivedHash === storedHash;
  } catch (e) {
    console.error("Error verifying Django password:", e);
    return false;
  }
};

// @desc    Register a new user
// @route   POST /accounts/auth/signup/
// @access  Public
export const registerUser = async (req, res, next) => {
  const { email, password, role, name, phone } = req.body;

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

    // Create Profile based on role
    if (role === "vendor") {
      await prisma.vendorProfile.create({
        data: {
          userId: user.id,
          business_name: name || (email ? email.split("@")[0] : "New Vendor"),
          phone: phone || "",
          onboarding_completed: false,
        },
      });
    } else {
      await prisma.userProfile.create({
        data: {
          userId: user.id,
          name: name || (email ? email.split("@")[0] : "User"),
          phone: phone || "",
        },
      });
    }

    res.status(201).json({
      id: user.id,
      email: user.email,
      role: user.role,
      token: generateToken(user.id),
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

        const userData = {
          id: user.id,
          email: user.email,
          role: user.role,
          is_active: user.is_active,
          ...profileData,
        };

        return res.json({
          user: userData,
          access: generateToken(user.id),
          refresh: generateToken(user.id),
        });
      }
    }

    res.status(401).json({ message: "Invalid email or password" });
  } catch (error) {
    console.error(error);
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
    const decoded = jwt.verify(refresh, JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });

    if (!user) return res.status(401).json({ message: "User not found" });

    res.json({
      access: generateToken(user.id),
      // Optionally rotate refresh token
      refresh: refresh,
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

    await prisma.blacklistedToken.create({
      data: {
        token,
        expiresAt: new Date(decoded.exp * 1000),
      },
    });
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Logout failed" });
  }
};

import { sendEmail, sendSMS } from "../util/communication.js";

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

    // save token for expiry ( 1 minute for now )
    await prisma.user.update({
      where: { email },
      data: {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: new Date(Date.now() + 1 * 60 * 1000),
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

// @desc    Send Phone OTP
export const sendPhoneOTP = async (req, res) => {
  const { phone_number } = req.body;

  if (!phone_number) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  try {
    const otp = generateOTP();
    console.log(`[OTP] Generated for ${phone_number}: ${otp}`);

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
    res
      .status(500)
      .json({ error: "Failed to send OTP", details: error.message });
  }
};

// @desc    Verify Phone OTP
export const verifyPhoneOTP = async (req, res) => {
  console.log('ðŸ” [verifyPhoneOTP] Called');
  console.log('ðŸ” [verifyPhoneOTP] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('ðŸ” [verifyPhoneOTP] Body:', JSON.stringify(req.body, null, 2));
  console.log('ðŸ” [verifyPhoneOTP] Query:', JSON.stringify(req.query, null, 2));
  
  const { phone_number, otp } = req.body;
  
  console.log('ðŸ” [verifyPhoneOTP] Extracted - phone_number:', phone_number, 'otp:', otp);

  if (!phone_number || !otp) {
    console.error('âŒ [verifyPhoneOTP] Missing required fields');
    return res.status(400).json({ error: "Phone number and OTP are required" });
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

    console.log('[sendEmailOTP] Generating OTP:', { email: normalizedEmail, otp });

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

    console.log('[sendEmailOTP] OTP record created:', { id: record.id, email: record.email, otp: record.otp, expiresAt: record.expiresAt });

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

  console.log('verifyEmailOTP - Received:', { email, otp, bodyKeys: Object.keys(req.body) });

  if (!email || !otp) {
    return res.status(400).json({ error: "Email and OTP are required" });
  }

  try {
    // Normalize inputs
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedOtp = String(otp).trim();

    console.log('verifyEmailOTP - Normalized:', { normalizedEmail, normalizedOtp });

    // Find the most recent OTP record for this email
    const record = await prisma.emailOTP.findFirst({
      where: { 
        email: normalizedEmail
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    console.log('verifyEmailOTP - Found record:', record ? { 
      id: record.id, 
      email: record.email, 
      otp: record.otp,
      verified: record.verified, 
      expiresAt: record.expiresAt,
      createdAt: record.createdAt 
    } : 'null');

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
      console.log('verifyEmailOTP - OTP mismatch:', { 
        expected: record.otp, 
        expectedType: typeof record.otp,
        received: normalizedOtp,
        receivedType: typeof normalizedOtp 
      });
      return res.status(400).json({ error: "Invalid OTP" });
    }

    await prisma.emailOTP.update({
      where: { id: record.id },
      data: { verified: true },
    });

    console.log('verifyEmailOTP - OTP verified successfully');

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
      access: generateToken(user.id),
      refresh: generateToken(user.id),
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

// @desc    Google Login
export const googleLogin = async (req, res) => {
  const { idToken, role } = req.body;

  console.log('Google Login - Received role:', role, 'idToken length:', idToken?.length);

  try {
    // Verify token with Firebase Admin
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const email = decodedToken.email;
    const name = decodedToken.name || email.split("@")[0];

    console.log('Google Login - Decoded email:', email, 'name:', name);

    let user = await prisma.user.findUnique({ 
      where: { email },
      include: {
        userProfile: true,
        vendorProfile: true,
      }
    });

    if (!user) {
      console.log('Google Login - Creating new user with role:', role || 'user');
      
      // Register new user
      user = await prisma.user.create({
        data: {
          email,
          password: "", // Social login has no password
          role: role || "user",
          is_active: true,
        },
      });

      // Create Profile
      if (role === "vendor") {
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

    console.log('Google Login - User found/created, role:', user.role);

    // Build response with profile data
    const userData = {
      id: user.id,
      email: user.email,
      role: user.role,
      is_active: user.is_active,
    };

    if (user.role === "vendor" && user.vendorProfile) {
      userData.business_name = user.vendorProfile.business_name;
      userData.phone = user.vendorProfile.phone;
      userData.address = user.vendorProfile.address;
      userData.image = user.vendorProfile.image;
      userData.cover_image = user.vendorProfile.cover_image;
      userData.onboarding_completed = user.vendorProfile.onboarding_completed;
      userData.status = user.vendorProfile.status;
    } else if (user.userProfile) {
      userData.name = user.userProfile.name;
      userData.phone = user.userProfile.phone;
      userData.address = user.userProfile.address;
      userData.profile_picture = user.userProfile.profile_picture;
    }

    res.json({
      access: generateToken(user.id),
      refresh: generateToken(user.id),
      user: userData,
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
    // Handle file uploads from multer (Cloudinary URLs)
    console.log("[UserProfile UPDATE] Request received");
    console.log(
      "[UserProfile UPDATE] Body:",
      JSON.stringify(req.body, null, 2),
    );

    if (req.files) {
      console.log(
        "[UserProfile UPDATE] Files:",
        JSON.stringify(req.files, null, 2),
      );
    } else {
      console.log("[UserProfile] No files received or multer failed to parse");
    }

    const uploadedProfilePicture = req.files?.profile_picture?.[0]?.path;
    const uploadedIdFront = req.files?.id_proof_front?.[0]?.path;
    const uploadedIdBack = req.files?.id_proof_back?.[0]?.path;

    if (uploadedProfilePicture) {
      console.log("-> SET: Profile Picture URL:", uploadedProfilePicture);
    }
    if (uploadedIdFront) {
      console.log("-> SET: ID Front URL:", uploadedIdFront);
    }
    if (uploadedIdBack) {
      console.log("-> SET: ID Back URL:", uploadedIdBack);
    }

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

    console.log(
      "[UserProfile] Final Update Data:",
      JSON.stringify(profileUpdateData, null, 2),
    );

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

    console.log("[UserProfile] Profile Updated Successfully:", {
      userId,
      hasProfilePicture: !!profile.profile_picture,
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

    console.log('ðŸ“± Updating push token for user:', userId, 'Token:', pushToken?.substring(0, 20) + '...');

    await prisma.user.update({
      where: { id: userId },
      data: { pushToken }
    });

    console.log('âœ… Push token updated successfully');

    res.json({ success: true, message: 'Push token updated' });
  } catch (error) {
    console.error('âŒ Update push token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
// ======================
// keplix-backend/server.js
// ======================

