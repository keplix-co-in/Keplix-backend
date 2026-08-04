import { z } from "zod";

export const createPaymentSchema = z.object({
  amount: z.number().positive({ message: "Amount must be positive" })
    .or(z.string().transform((val) => Number(val)).refine((val) => val > 0, { message: "Amount must be positive" })),
  currency: z.string().optional().default("INR"),
  bookingId: z
    .number({ required_error: "bookingId is required" })
    .or(z.string().transform((val) => Number(val))),
  gateway: z.union([z.string(), z.undefined()]).transform(val => val || 'razorpay').transform(val => val.toLowerCase()).pipe(z.enum(["stripe", "razorpay", "vendor", "cash", "user"], {
    message: "Gateway must be stripe, razorpay, vendor, cash, or user",
  })),
});

export const verifyPaymentSchema = z.object({
  orderId: z.string().optional(),
  paymentId: z.string().optional(),
  signature: z.string().optional(),

  bookingId: z
    .number({ required_error: "bookingId is required" })
    .or(z.string().transform((val) => Number(val))),

  gateway: z.string().optional(),
});
