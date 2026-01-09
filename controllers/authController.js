import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createRequire } from 'module';
import admin from 'firebase-admin';

const require = createRequire(import.meta.url);
const serviceAccount = require('../serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'django-insecure-secret-key-replacement';

const generateToken = (id) => {
    return jwt.sign({ id }, JWT_SECRET, {
        expiresIn: '30d',
    });
};

// @desc    Register a new user
// @route   POST /accounts/auth/signup/
// @access  Public
export const registerUser = async (req, res) => {
    const { email, password, role, name, phone } = req.body;

    try {
        const userExists = await prisma.user.findUnique({
            where: { email },
        });

        if (userExists) {
            return res.status(400).json({ message: 'User already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create User
        const user = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                role: role || 'user',
            },
        });

        // Create Profile based on role
        if (role === 'vendor') {
            await prisma.vendorProfile.create({
                data: {
                    userId: user.id,
                    business_name: name || 'New Vendor',
                    phone: phone || '',
                    onboarding_completed: false
                }
            });
        } else {
            await prisma.userProfile.create({
                data: {
                    userId: user.id,
                    name: name || email.split('@')[0],
                    phone: phone || ''
                }
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
        res.status(500).json({ message: 'Server Error' });
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
        });

        if (user && (await bcrypt.compare(password, user.password))) {
            res.json({
                id: user.id,
                email: user.email,
                role: user.role,
                access: generateToken(user.id), // Frontend expects 'access' for JWT
                refresh: generateToken(user.id), // Dummy refresh for now
            });
        } else {
            res.status(401).json({ message: 'Invalid email or password' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get user profile
// @route   GET /accounts/auth/profile/
// @access  Private
export const getUserProfile = async (req, res) => {
    const user = req.user;

    if (user) {
        let profileData = {};
        if (user.role === 'vendor') {
            profileData = user.vendorProfile || {};
        } else {
            profileData = user.userProfile || {};
        }

        res.json({
            id: user.id,
            email: user.email,
            role: user.role,
            ...profileData
        });
    } else {
        res.status(404).json({ message: 'User not found' });
    }
};

// @desc    Refresh Token
// @route   POST /accounts/auth/token/refresh/
export const refreshToken = async (req, res) => {
    const { refresh } = req.body;
    if (!refresh) return res.status(400).json({ message: "Refresh token required" });

    try {
        const decoded = jwt.verify(refresh, JWT_SECRET);
        const user = await prisma.user.findUnique({ where: { id: decoded.id } });

        if (!user) return res.status(401).json({ message: "User not found" });

        res.json({
            access: generateToken(user.id),
            refresh: refresh // Simple echo for now, usually you rotate it
        });
    } catch (e) {
        res.status(401).json({ message: "Invalid refresh token" });
    }
}

// @desc    Logout User
// @route   POST /accounts/auth/logout/
export const logoutUser = (req, res) => {
    // In JWT, client just deletes token. Server can blacklist.
    // For now, just return success.
    res.json({ message: "Logged out successfully" });
}

// @desc    Forgot Password (Stub)
// @route   POST /accounts/auth/forgot-password/
export const forgotPassword = async (req, res) => {
    const { email } = req.body;
    // In parity, we would send an email. For now, stub it.
    console.log(`[Stub] Forgot password for: ${email}`);
    res.json({ detail: "Password reset email sent" });
}

// @desc    Reset Password (Stub)
// @route   POST /accounts/auth/reset-password/:uid/:token/
export const resetPassword = async (req, res) => {
    const { password } = req.body;
    // Stub: assume validated and update logic would go here
    res.json({ detail: "Password reset successful" });
}

// @desc    Send Phone OTP (Stub)
// @route   POST /accounts/auth/send-phone-otp/
export const sendPhoneOTP = async (req, res) => {
    const { phone_number } = req.body;
    // Stub
    console.log(`[Stub] OTP sent to ${phone_number}`);
    res.json({ detail: "OTP sent successfully", phone_number });
}

// @desc    Verify Phone OTP (Stub)
// @route   POST /accounts/auth/verify-phone-otp/
export const verifyPhoneOTP = async (req, res) => {
    // Stub: always success
    res.json({ detail: "Phone number verified successfully", verified: true });
}

// @desc    Google Login
// @route   POST /accounts/auth/google/
export const googleLogin = async (req, res) => {
    const token = req.body.token || req.body.id_token;

    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        const { email, name, uid } = decodedToken;

        if (!email) {
            return res.status(400).json({ error: 'Email not found in token' });
        }

        let user = await prisma.user.findUnique({
             where: { email },
        });

        if (!user) {
             // Create User with random password
             const randomPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
             const salt = await bcrypt.genSalt(10);
             const hashedPassword = await bcrypt.hash(randomPassword, salt);

             user = await prisma.user.create({
                 data: {
                     email,
                     password: hashedPassword,
                     role: 'user',
                     is_active: true,
                 }
             });

             // Create UserProfile
             await prisma.userProfile.create({
                 data: {
                     userId: user.id,
                     name: name || email.split('@')[0],
                 }
             });
        }

        res.json({
            id: user.id,
            email: user.email,
            role: user.role,
            access: generateToken(user.id),
            refresh: generateToken(user.id),
        });

    } catch (error) {
        console.error("Google Login Error:", error);
        res.status(400).json({ error: 'Invalid token or login failed' });
    }
};

