import { z } from 'zod';
import { normalizeIndianPhone } from '../../util/phone.js';

export const createWalkInJobSchema = z.object({
  customer_name: z.string().trim().min(2, 'Name is too short').max(100),
  customer_phone: z
    .string()
    .transform((v) => normalizeIndianPhone(v))
    .refine((v) => v !== null, { message: 'Enter a valid 10-digit Indian mobile number' }),
  vehicle: z.object({
    // Uppercased/stripped again in the controller against the same
    // registration a vendor may already have on file — kept loose here
    // (Zod runs before that lookup) and tightened there.
    registration: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{4,12}$/, 'Enter a valid registration number'),
    make: z.string().trim().max(50).optional(),
    model: z.string().trim().max(50).optional(),
    year: z.coerce
      .number()
      .int()
      .min(1950)
      .max(new Date().getFullYear() + 1)
      .optional(),
    fuel_type: z.enum(['petrol', 'diesel', 'cng', 'electric', 'hybrid']).optional(),
    odometer_km: z.coerce.number().int().min(0).max(2_000_000).optional(),
  }),
  description: z.string().trim().max(2000).optional(),
  amount_collected: z.coerce.number().nonnegative().optional(),
  payment_mode: z.enum(['cash', 'upi', 'card']).optional(),
});

export const updateWalkInJobSchema = z.object({
  customer_name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(2000).optional(),
  amount_collected: z.coerce.number().nonnegative().optional(),
  payment_mode: z.enum(['cash', 'upi', 'card']).optional(),
});

export const updateWalkInJobStatusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'completed', 'cancelled'], {
    message: 'Invalid status',
  }),
});
