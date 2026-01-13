import { z } from 'zod';

export const createBookingSchema = z.object({
  serviceId: z.number().int().positive({ message: "Service ID is required" }),
  booking_date: z.string().datetime({ message: "Invalid date format (ISO 8601 required)" }),
  booking_time: z.string().min(1, { message: "Booking time is required" }),
  notes: z.string().optional(),
});

export const updateBookingSchema = z.object({
  booking_date: z.string().datetime({ message: "Invalid date format" }).optional(),
  booking_time: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['pending', 'cancelled']).optional(), 
});
