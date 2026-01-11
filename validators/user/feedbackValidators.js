import { z } from 'zod';

export const createFeedbackSchema = z.object({
  title: z.string().min(1, { message: "Title is required" }),
  message: z.string().min(1, { message: "Message is required" }),
  category: z.string().min(1, { message: "Category is required" }),
});
