import { z } from 'zod';

export const createReviewSchema = z.object({
  bookingId: z.number().int().positive({ message: "Booking ID is required" }),
  rating: z.number().min(1).max(5, { message: "Rating must be between 1 and 5" }),
  comment: z.string().optional(),
});
