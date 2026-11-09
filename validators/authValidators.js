import { z } from 'zod';

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
