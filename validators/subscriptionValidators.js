import { z } from 'zod';

export const createSubscriptionOrderSchema = z.object({
  // One plan, monthly only (owner decision 2026-11-25); anything else is a 400.
  plan_code: z.literal('gold'),
  period: z.literal('monthly'),
});

export const verifySubscriptionSchema = z.object({
  razorpay_order_id: z.string().trim().min(1).max(100),
  razorpay_payment_id: z.string().trim().min(1).max(100),
  razorpay_signature: z.string().trim().min(1).max(200),
});

// Admin edits. Prices >= 0, up to 10 short feature strings (contract).
const price = z.coerce.number().finite().min(0).max(10000000);
export const updatePlanSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  monthly_price: price.optional(),
  features: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(1000).optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'Nothing to update' });

export const extendSubscriptionSchema = z.object({
  days: z.coerce.number().int().min(1).max(730),
  reason: z.string().trim().min(3).max(300),
});
