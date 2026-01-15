import { z } from 'zod';

const jsonString = z.string().or(z.array(z.any())).transform((val) => {
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
});

export const createVendorProfileSchema = z.object({
  business_name: z.string().min(1, { message: "Business name is required" }),
  business_type: z.string().optional(),
  description: z.string().optional(),
  
  phone: z.string().min(1, { message: "Phone number is required" }),
  alternate_phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  
  owner_name: z.string().optional(),
  date_of_birth: z.string().optional(),

  // Address
  address: z.string().optional(),
  street: z.string().optional(),
  area: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  landmark: z.string().optional(),

  // Location
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),

  // Tax
  gst_number: z.string().optional(),
  has_gst: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional(),
  tax_type: z.string().optional(),

  // Timings
  operating_hours: z.string().optional(),
  breaks: jsonString.optional(),
  holidays: jsonString.optional(),
});

export const updateVendorProfileSchema = createVendorProfileSchema.partial();
