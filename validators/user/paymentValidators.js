import { z } from "zod";

export const createPaymentSchema = z.object({
  amount: z.number().positive({ message: "Amount must be positive" }),
  currency: z.string().optional().default("INR"),
  gateway: z.enum(["stripe", "razorpay"], {
    message: "Gateway must be stripe or razorpay",
  }),
});

export const verifyPaymentSchema = z.object({
  orderId: z.string({ required_error: "orderId is required" }),
  paymentId: z.string({ required_error: "paymentId is required" }),
  signature: z.string({ required_error: "signature is required" }),

  bookingId: z
    .number()
    .optional()
    .or(z.string().transform((val) => Number(val))),

  amount: z
    .number({ required_error: "amount is required" })
    .or(z.string().transform((val) => Number(val))),
});
