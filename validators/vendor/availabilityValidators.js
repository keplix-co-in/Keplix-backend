import { z } from 'zod';

export const manageAvailabilitySchema = z.object({
  day_of_week: z.string().min(1, { message: "Day of week is required" }),
  start_time: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: "Invalid time format (HH:MM)" }),
  end_time: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: "Invalid time format (HH:MM)" }),
  is_available: z.boolean().optional(),
});
