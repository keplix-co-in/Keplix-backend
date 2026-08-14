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
