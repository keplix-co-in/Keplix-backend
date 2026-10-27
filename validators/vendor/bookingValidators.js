import { z } from 'zod';

export const respondToServiceRequestSchema = z.object({
  vendor_status: z.enum(['accepted', 'rejected', 'declined'], { 
    message: "Vendor status must be 'accepted', 'rejected', or 'declined'" 
  }).transform((val) => val === 'declined' ? 'rejected' : val), // Convert 'declined' to 'rejected'
  // Why the vendor declined, shown to the customer and stored in
  // Booking.vendor_reject_reason. Optional so the shipped vendor app, which
  // sends only vendor_status, keeps working. Must be declared here: this is a
  // z.object, and validateRequest replaces req.body with the parsed result, so
  // an undeclared key is silently stripped before the controller sees it.
  reason: z.string().trim().max(500, { message: "Reason too long (maximum 500 characters)" }).optional(),
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
  // Completion notes sent alongside status:'service_completed' (multipart).
  // The controller has always written `notes` when present, but the key was
  // never declared, so validateRequest stripped it and the vendor's notes were
  // silently dropped on every completion.
  notes: z.string().max(2000).optional(),
});

// Vendor's early-start request. Both fields optional: with no booking_time the
// controller uses "now", rounded to the current half-hour slot. The time is a
// free-text clock string (the whole codebase stores times that way) and is
// validated properly by util/slots.js toCanonicalTime in the controller.
export const requestEarlyStartSchema = z.object({
  booking_time: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});
