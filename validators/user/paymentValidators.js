import { z } from 'zod';

export const createPaymentSchema = z.object({
  amount: z.number().positive({ message: "Amount must be positive" }),
  currency: z.string().optional().default("INR"),
  gateway: z.enum(['stripe', 'razorpay'], { message: "Gateway must be stripe or razorpay" }),
});

export const verifyPaymentSchema = z.object({
  paymentId: z.string().min(1, { message: "Payment ID is required" }),
  orderId: z.string().optional(),
  signature: z.string().optional(),
  bookingId: z.number().int().optional().or(z.string().transform(val => parseInt(val))), // Handle string/number
  gateway: z.string(),
  amount: z.number().or(z.string().transform(val => parseFloat(val)))
});
