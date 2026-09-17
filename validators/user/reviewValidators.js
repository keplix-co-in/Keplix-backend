import { z } from 'zod';

export const createReviewSchema = z.object({
  bookingId: z.number().int().positive({ message: "Booking ID is required" }),
  // Review.rating is an Int column, so a 4.5 here was accepted by validation
  // and then rejected by Prisma — the review simply failed to save.
  rating: z.number().int({ message: "Rating must be a whole number" }).min(1).max(5, { message: "Rating must be between 1 and 5" }),
  comment: z.string().optional(),
});

// audit #78: there was no way to edit a submitted review at all -- both
// fields optional so a caller can update just the rating or just the
// comment, but the endpoint itself requires at least one (checked in the
// controller, since Zod's per-field .optional() can't express "at least one
// of these").
export const updateReviewSchema = z.object({
  rating: z.number().int({ message: "Rating must be a whole number" }).min(1).max(5, { message: "Rating must be between 1 and 5" }).optional(),
  comment: z.string().optional(),
});
