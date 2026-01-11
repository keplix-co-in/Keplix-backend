import { z } from 'zod';

export const createInventorySchema = z.object({
  item_name: z.string().min(1),
  stock_level: z.coerce.number().int().min(0),
});

export const updateInventorySchema = z.object({
  item_name: z.string().optional(),
  stock_level: z.coerce.number().int().min(0).optional(),
});
