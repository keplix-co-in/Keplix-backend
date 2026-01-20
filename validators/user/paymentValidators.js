import { z } from 'zod';

export const createPaymentSchema = z.object({
  amount: z.number().positive({ message: "Amount must be positive" }),
  currency: z.string().optional().default("INR"),
  gateway: z.enum(['stripe', 'razorpay'], { message: "Gateway must be stripe or razorpay" }),
});

export const verifyPaymentSchema = z.object({
  id: z.string().min(1, { message: "Order ID is required" }), // Razorpay order_xxx
  amount: z.number().or(z.string().transform(val => parseFloat(val))),
  currency: z.string().optional().default("INR"),
  gateway: z.string(),
  status: z.string().optional(), // created, paid, etc.
  
  // Optional fields
  paymentId: z.string().optional(), // Actual payment ID (pay_xxx) if payment completed
  signature: z.string().optional(), // For signature verification
  bookingId: z.number().int().optional().or(z.string().transform(val => parseInt(val))),
});
