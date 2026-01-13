import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createRequire } from 'module';
import admin from 'firebase-admin';
import crypto from 'crypto';

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

const verifyDjangoPassword = (password, hash) => {
    try {
        const parts = hash.split('$');
        if (parts.length !== 4) return false;
        
        const [algorithm, iterations, salt, storedHash] = parts;
        if (algorithm !== 'pbkdf2_sha256') return false;
    
        const keyLen = 32; // SHA256 produces 32 bytes
        const derivedKey = crypto.pbkdf2Sync(password, salt, parseInt(iterations), keyLen, 'sha256');
        const derivedHash = derivedKey.toString('base64');
        
        return derivedHash === storedHash;
    } catch (e) {
        console.error("Error verifying Django password:", e);
        return false;
    }
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
                    business_name: name || (email ? email.split('@')[0] : 'New Vendor'),
                    phone: phone || '',
                    onboarding_completed: false
                }
            });
        } else {
            await prisma.userProfile.create({
                data: {
                    userId: user.id,
                    name: name || (email ? email.split('@')[0] : 'User'),
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

        if (user) {
            let isValid = false;
            // Check if it's a Django PBKDF2 hash
            if (user.password.startsWith('pbkdf2_sha256$')) {
                isValid = verifyDjangoPassword(password, user.password);
            } else {
                // Otherwise assume bcrypt (new users or dummy data)
                isValid = await bcrypt.compare(password, user.password);
            }

            if (isValid) {
                return res.json({
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    access: generateToken(user.id),
                    refresh: generateToken(user.id),
                });
            }
        }
        
        res.status(401).json({ message: 'Invalid email or password' });
        
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
            // Optionally rotate refresh token
            refresh: refresh 
        });
    } catch (error) {
        console.error("Token refresh error:", error);
        res.status(401).json({ message: "Invalid refresh token" });
    }
};

// @desc    Logout user
// @route   POST /accounts/auth/logout/
export const logoutUser = async (req, res) => {
    // Client side just clears token.
    res.json({ message: 'Logged out successfully' });
};

// @desc    Forgot Password
export const forgotPassword = async (req, res) => {
    // Mock implementation for now
    res.json({ message: 'Password reset link sent (mock)' });
};

// @desc    Reset Password
export const resetPassword = async (req, res) => {
    res.json({ message: 'Password reset successfully (mock)' });
};

// @desc    Send Phone OTP
export const sendPhoneOTP = async (req, res) => {
    res.json({ message: 'OTP sent (mock)' });
};

// @desc    Verify Phone OTP
export const verifyPhoneOTP = async (req, res) => {
    res.json({ message: 'OTP verified (mock)' });
};

// @desc    Send Email OTP
export const sendEmailOTP = async (req, res) => {
    // Implement real email sending logic here (e.g. Nodemailer)
    // For now, mock it
    res.json({ message: 'Email OTP sent (mock)' });
};

// @desc    Verify Email OTP
export const verifyEmailOTP = async (req, res) => {
    res.json({ message: 'Email OTP verified (mock)' });
};

// @desc    Google Login
export const googleLogin = async (req, res) => {
    const { idToken, role } = req.body;
    
    try {
        // Verify token with Firebase Admin
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const email = decodedToken.email;
        const name = decodedToken.name || email.split('@')[0];
        
        let user = await prisma.user.findUnique({ where: { email } });
        
        if (!user) {
            // Register new user
            user = await prisma.user.create({
                data: {
                    email,
                    password: '', // Social login has no password
                    role: role || 'user',
                    is_active: true
                }
            });
            
            // Create Profile
            if (role === 'vendor') {
                await prisma.vendorProfile.create({
                    data: {
                        userId: user.id,
                        business_name: name,
                        phone: '',
                        onboarding_completed: false
                    }
                });
            } else {
                 await prisma.userProfile.create({
                    data: {
                        userId: user.id,
                        name: name,
                        phone: ''
                    }
                });
            }
        }
        
        res.json({
            id: user.id,
            email: user.email,
            role: user.role,
            access: generateToken(user.id),
            refresh: generateToken(user.id)
        });
        
    } catch (error) {
        console.error('Google Login Error:', error);
        res.status(401).json({ message: 'Invalid token' });
    }
};

