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

  // Operating hours and schedule
  operating_hours: z.string().optional(),
  breaks: z.union([z.string(), z.array(z.any())]).optional(),
  holidays: z.union([z.string(), z.array(z.any())]).optional(),
  
  // Onboarding status
  onboarding_completed: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional(),

  // Bank Details
  bank_account_number: z.string().optional(),
  ifsc_code: z.string().optional(),
  upi_id: z.string().optional(),

  // Image fields (Optional, but allow passing them through if Zod strips keys)
  // Since Zod parse replaces req.body, if we don't include them, they might be lost if they were in body?
  // Actually, files are in req.files, so we don't need them here usually.
  // BUT if the frontend sends "cover_image": "null" string or something, we want to handle it.
  image: z.any().optional(),
  cover_image: z.any().optional(),
});

export default createVendorProfileSchema;

export const updateVendorProfileSchema = createVendorProfileSchema.partial();
