import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(6, { message: "Password must be at least 6 characters long" }),
  name: z.string().min(2, { message: "Name must be at least 2 characters long" }).optional(),
  role: z.enum(['user', 'vendor'], { message: "Role must be either 'user' or 'vendor'" }).optional(),
  phone: z.string().optional(), // Add specific regex for phone number if needed
});

export const loginSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(1, { message: "Password is required" }),
});

export const refreshTokenSchema = z.object({
  refresh: z.string({ required_error: "Refresh token is required" }),
});
