import { z } from 'zod';

export const createBookingSchema = z.object({
  serviceId: z.number().int().positive({ message: "Service ID is required" }),
  booking_date: z.string().datetime({ message: "Invalid date format (ISO 8601 required)" }),
  booking_time: z.string().min(1, { message: "Booking time is required" }),
  notes: z.string().optional(),
});

export const updateBookingSchema = z.object({
  booking_date: z.string().optional(), // Allow flexible date formats
  booking_time: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['pending', 'confirmed', 'scheduled', 'in_progress', 'service_completed', 'completed', 'cancelled', 'disputed', 'refunded']).optional(),
});

export const confirmServiceSchema = z.object({
  confirmed: z.boolean({ required_error: "Confirmation required" }),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(500).optional(),
});

export const disputeServiceSchema = z.object({
  reason: z.string().min(10, { message: "Please provide a detailed reason (minimum 10 characters)" })
    .max(1000, { message: "Reason too long (maximum 1000 characters)" }),
});
