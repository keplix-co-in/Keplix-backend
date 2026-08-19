import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(6, { message: "Password must be at least 6 characters long" }),
  name: z.string().min(2, { message: "Name must be at least 2 characters long" }).optional(),
  role: z.enum(['user', 'vendor'], { message: "Role must be either 'user' or 'vendor'" }).optional(),
  phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, { message: "Invalid phone number format" }).optional(),
});

export const loginSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(1, { message: "Password is required" }),
});

export const refreshTokenSchema = z.object({
  refresh: z.string({ required_error: "Refresh token is required" }),
});

export const updatePasswordSchema = z.object({
  oldPassword: z.string().min(1, { message: "Old password is required" }),
  newPassword: z.string().min(6, { message: "New password must be at least 6 characters long" }),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(6, { message: "Password must be at least 6 characters long" }),
  re_password: z.string().min(6).optional(), // compatibility with djoser/others
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordWithOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6, { message: "OTP must be 6 digits" }),
  password: z.string().min(6, { message: "Password must be at least 6 characters long" }),
});

export const googleLoginSchema = z.object({
  // Shape check only — the real verification (signature, expiry, issuer and
  // crucially the audience) happens in googleLogin via
  // google-auth-library's verifyIdToken. This just rejects obvious junk before
  // it costs a network round trip, and caps length so an oversized body can't
  // be used to tie up the verifier.
  idToken: z
    .string()
    .min(1, { message: "Google ID Token is required" })
    .max(4096, { message: "Malformed Google ID Token" })
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, {
      message: "Malformed Google ID Token",
    }),
  role: z.enum(['user', 'vendor']).optional(),
});

export const requestOtpSchema = z.object({
    phone_number: z.string().regex(/^\+?[1-9]\d{1,14}$/, { message: "Invalid phone number" }).optional(),
    email: z.string().email().optional()
}).refine(data => data.phone_number || data.email, {
    message: "Either phone_number or email is required"
});

export const verifyOtpSchema = z.object({
    phone_number: z.string().optional(),
    email: z.string().email().optional(),
    otpId: z.int().optional(),
    otp: z.string().length(6, { message: "OTP must be 6 digits" })
}).refine(data => data.phone_number || data.email, {
    message: "Either phone_number or email is required for OTP verification"
});
