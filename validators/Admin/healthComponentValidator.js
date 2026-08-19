import { z } from 'zod';

export const createHealthComponentSchema = z.object({
  key: z.string().trim().min(1).max(50).regex(/^[a-z0-9_]+$/, 'lowercase letters, numbers and underscores only'),
  label: z.string().trim().min(1).max(100),
  display_order: z.coerce.number().int().min(0).optional(),
});

export const updateHealthComponentSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  display_order: z.coerce.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
});
