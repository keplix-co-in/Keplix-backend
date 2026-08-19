import { z } from "zod";

export const createPaymentSchema = z.object({
<<<<<<< HEAD
  amount: z.number().positive({ message: "Amount must be positive" })
    .or(z.string().transform((val) => Number(val)).refine((val) => val > 0, { message: "Amount must be positive" })),
  currency: z.string().optional().default("INR"),
=======
  // `amount` is accepted for backward compatibility with already-released app
  // builds, but the server IGNORES it and prices the order from the booking's
  // service. Clients must never be able to choose what they are charged.
  amount: z.any().optional(),
  currency: z.string().optional().default("INR"),
  bookingId: z
    .number({ required_error: "bookingId is required" })
    .or(z.string().transform((val) => Number(val))),
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
  gateway: z.union([z.string(), z.undefined()]).transform(val => val || 'razorpay').transform(val => val.toLowerCase()).pipe(z.enum(["stripe", "razorpay", "vendor", "cash", "user"], {
    message: "Gateway must be stripe, razorpay, vendor, cash, or user",
  })),
});

export const verifyPaymentSchema = z.object({
<<<<<<< HEAD
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
=======
  orderId: z.string().optional(),
  paymentId: z.string().optional(),
  signature: z.string().optional(),

  bookingId: z
    .number({ required_error: "bookingId is required" })
    .or(z.string().transform((val) => Number(val))),

  // Must be an enum, not a free string. An unconstrained `gateway` here was
  // what let a caller pass "upi" and skip signature verification entirely.
  // Only online gateways are self-reportable by the paying user.
  gateway: z
    .union([z.string(), z.undefined()])
    .transform((val) => (val || 'razorpay').toLowerCase())
    .pipe(
      z.enum(["razorpay"], {
        message: "Gateway must be razorpay",
      }),
    ),
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
});
