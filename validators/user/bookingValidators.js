import { z } from 'zod';

export const createBookingSchema = z.object({
  serviceId: z.number().int().positive({ message: "Service ID is required" }),
  booking_date: z.string().datetime({ message: "Invalid date format (ISO 8601 required)" }),
  booking_time: z.string().min(1, { message: "Booking time is required" }),
  notes: z.string().optional(),
  // Optional: which of the user's saved cars this booking is for. Absent
  // entirely is a normal booking with no segment pricing, same as before this
  // field existed — nothing here is required.
  vehicleId: z.number().int().positive().optional(),
});

export const updateBookingSchema = z.object({
  booking_date: z.string().optional(), // Allow flexible date formats
  booking_time: z.string().optional(),
  notes: z.string().optional(),
  // CUSTOMER-facing endpoint, so the only status a customer legitimately owns is
  // cancellation. This used to accept the full lifecycle enum, which meant a
  // customer could PUT {status:"service_completed"} on their own booking -- the
  // exact precondition confirmBookingAndQueuePayout requires -- and then call
  // /confirm to release the vendor payout with no vendor involvement and no check
  // that the booking had been paid for. The escrow hold was bypassed with it,
  // since payoutHoldUntil is enforced only on the admin settle path.
  //
  // Verified against the customer app before narrowing: CancelBooking.jsx is the
  // only caller that sends a status, and it sends 'cancelled'. Reschedule sends
  // booking_date/booking_time with no status at all, so it is unaffected.
  //
  // Vendor-owned transitions belong to the vendor endpoint
  // (controllers/vendor/bookingController.js updateBookingStatus).
  status: z.enum(['cancelled']).optional(),
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

// The customer's answer to a vendor's early-start request. Strictly boolean:
// a missing or string value would otherwise be read as "decline" by
// `accept === true`, silently turning a malformed accept into a refusal.
export const earlyStartRespondSchema = z.object({
  accept: z.boolean({ message: "accept must be true or false" }),
});
