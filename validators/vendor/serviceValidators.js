import { z } from 'zod';

export const createServiceSchema = z.object({
  name: z.string().min(1, { message: "Service name is required" }),
  description: z.string().min(1, { message: "Description is required" }),
  price: z.coerce.number().positive({ message: "Price must be positive" }), 
  duration: z.coerce.number().int().positive({ message: "Duration must be positive (minutes)" }),
  category: z.string().min(1, { message: "Category is required" }),
  image: z.string().optional(),
  is_active: z.boolean().optional(),
});

export const updateServiceSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  price: z.coerce.number().positive().optional(),
  duration: z.coerce.number().int().positive().optional(),
  category: z.string().optional(),
  image: z.string().optional(),
});
