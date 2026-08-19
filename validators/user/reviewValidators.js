import { z } from 'zod';

export const createReviewSchema = z.object({
  bookingId: z.number().int().positive({ message: "Booking ID is required" }),
  // Review.rating is an Int column, so a 4.5 here was accepted by validation
  // and then rejected by Prisma — the review simply failed to save.
  rating: z.number().int({ message: "Rating must be a whole number" }).min(1).max(5, { message: "Rating must be between 1 and 5" }),
  comment: z.string().optional(),
});
