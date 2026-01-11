import { z } from 'zod';

export const createVendorProfileSchema = z.object({
  business_name: z.string().min(1, { message: "Business name is required" }),
  phone: z.string().min(1, { message: "Phone number is required" }),
  address: z.string().optional(), 
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),
  gst_number: z.string().optional(),
  operating_hours: z.string().optional(),
});

export const updateVendorProfileSchema = z.object({
  business_name: z.string().optional(),
  phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, { message: "Invalid phone number" }).optional(),
  address: z.string().optional(),
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),
  gst_number: z.string().optional(),
  operating_hours: z.string().optional(),
});
