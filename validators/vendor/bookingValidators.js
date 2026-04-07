import { z } from 'zod';

export const respondToServiceRequestSchema = z.object({
  vendor_status: z.enum(['accepted', 'rejected', 'declined'], { 
    message: "Vendor status must be 'accepted', 'rejected', or 'declined'" 
  }).transform((val) => val === 'declined' ? 'rejected' : val), // Convert 'declined' to 'rejected'
});

export const updateBookingStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'rejected'], { message: "Invalid status" }),
});
