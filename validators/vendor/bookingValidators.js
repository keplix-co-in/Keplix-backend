import { z } from 'zod';

export const updateBookingStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'rejected'], { message: "Invalid status" }),
});
