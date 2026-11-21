import { z } from 'zod';

export const updatePlatformSettingsSchema = z.object({
  isPlatformFeeEnabled: z.boolean().optional(),
  platformFeePercentage: z.number().min(0).max(1).optional(),
  isHealthSheetRequired: z.boolean().optional(),
  // ISO date string or null to clear it. Enforcing the gate with no
  // healthSheetRequiredFrom would gate every existing booking immediately —
  // the client should always set a future date alongside turning this on,
  // but the schema itself doesn't force that: see the rollout notes in
  // controllers/Admin/platformSettingsController.js.
  healthSheetRequiredFrom: z.string().datetime().nullable().optional(),
  // Pricing v2 switch (docs/PRICING_V2_API.md): bookings created at or after
  // this instant get a BookingQuote and use the final-bill flow. null = off.
  pricingV2From: z.string().datetime().nullable().optional(),
});
