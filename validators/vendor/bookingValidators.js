import { z } from 'zod';

export const respondToServiceRequestSchema = z.object({
  vendor_status: z.enum(['accepted', 'rejected', 'declined'], { 
    message: "Vendor status must be 'accepted', 'rejected', or 'declined'" 
  }).transform((val) => val === 'declined' ? 'rejected' : val), // Convert 'declined' to 'rejected'
});

export const updateBookingStatusSchema = z.object({
<<<<<<< HEAD
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'rejected'], { message: "Invalid status" }),
=======
  // Must match every status controllers/vendor/bookingController.js's
  // updateBookingStatus actually transitions to/from (in_progress,
  // service_completed) — this schema previously only allowed a narrower
  // set and silently rejected legitimate vendor status transitions.
  status: z.enum(
    ['pending', 'confirmed', 'scheduled', 'in_progress', 'service_completed', 'completed', 'cancelled', 'rejected'],
    { message: "Invalid status" }
  ),
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
});
