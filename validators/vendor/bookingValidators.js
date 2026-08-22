import { z } from 'zod';

export const respondToServiceRequestSchema = z.object({
  vendor_status: z.enum(['accepted', 'rejected', 'declined'], { 
    message: "Vendor status must be 'accepted', 'rejected', or 'declined'" 
  }).transform((val) => val === 'declined' ? 'rejected' : val), // Convert 'declined' to 'rejected'
});

export const updateBookingStatusSchema = z.object({
  // Must match every status controllers/vendor/bookingController.js's
  // updateBookingStatus actually transitions to/from (in_progress,
  // service_completed) — this schema previously only allowed a narrower
  // set and silently rejected legitimate vendor status transitions.
  status: z.enum(
    ['pending', 'confirmed', 'scheduled', 'in_progress', 'service_completed', 'completed', 'cancelled', 'rejected'],
    { message: "Invalid status" }
  ),
});

// Vendor's early-start request. Both fields optional: with no booking_time the
// controller uses "now", rounded to the current half-hour slot. The time is a
// free-text clock string (the whole codebase stores times that way) and is
// validated properly by util/slots.js toCanonicalTime in the controller.
export const requestEarlyStartSchema = z.object({
  booking_time: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});
