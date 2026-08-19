import { z } from 'zod';
import { normalizeIndianPhone } from '../../util/phone.js';

const phoneField = z
  .string()
  .transform((v) => normalizeIndianPhone(v))
  .refine((v) => v !== null, { message: 'Enter a valid 10-digit Indian mobile number' });

export const claimRequestSchema = z.object({ phone: phoneField });

export const claimVerifySchema = z.object({
  phone: phoneField,
  otp: z.string().trim().length(6, 'Enter the 6-digit code'),
});

// The five segments a service can be priced by. Kept as a literal tuple
// (not imported from Prisma) so this validator has no dependency on the
// generated client — the same pattern as every other enum-shaped Zod field
// in this codebase.
const vehicleSegmentField = z.enum(['HATCHBACK', 'SEDAN', 'COMPACT_SUV', 'MUV', 'LUXURY']);

export const createVehicleSchema = z.object({
  registration: z.string().trim().min(3).max(20),
  car_name: z.string().trim().max(60).nullish(),
  segment: vehicleSegmentField.nullish(),
  make: z.string().trim().max(60).nullish(),
  model: z.string().trim().max(60).nullish(),
  year: z.number().int().min(1980).max(new Date().getFullYear() + 1).nullish(),
  fuel_type: z.string().trim().max(30).nullish(),
  colour: z.string().trim().max(30).nullish(),
  is_primary: z.boolean().optional(),
});

// registration is intentionally absent here: it is how a vehicle is matched
// across vendors (vehicle_reg_per_vendor), so letting it be edited after
// creation would silently detach a car's history from itself.
export const updateVehicleSchema = z.object({
  car_name: z.string().trim().max(60).nullish(),
  segment: vehicleSegmentField.nullish(),
  make: z.string().trim().max(60).nullish(),
  model: z.string().trim().max(60).nullish(),
  year: z.number().int().min(1980).max(new Date().getFullYear() + 1).nullish(),
  fuel_type: z.string().trim().max(30).nullish(),
  colour: z.string().trim().max(30).nullish(),
  odometer_km: z.number().int().min(0).nullish(),
  is_primary: z.boolean().optional(),
});
