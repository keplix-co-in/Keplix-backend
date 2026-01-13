import { z } from 'zod';

export const createPaymentSchema = z.object({
  bookingId: z.number().int().positive({ message: "Booking ID is required" }),
  amount: z.number().positive({ message: "Amount must be positive" }),
  method: z.string().min(1, { message: "Payment method is required" }),
  transactionId: z.string().optional(),
});
