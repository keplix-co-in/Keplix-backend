import { z } from 'zod';

export const createPromotionSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  discount: z.coerce.number().positive(),
  start_date: z.string().datetime(),
  end_date: z.string().datetime(),
});

export const updatePromotionSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  discount: z.coerce.number().positive().optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  active: z.boolean().optional(),
});
