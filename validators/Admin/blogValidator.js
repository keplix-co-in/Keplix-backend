import { z } from "zod";

const STATUSES = ["draft", "published"];

export const createBlogSchema = z.object({
  title: z.string().trim().min(3).max(200),
  excerpt: z.string().trim().max(400).optional().or(z.literal("")),
  content: z.string().min(1, "Content is required"),
  category: z.string().trim().min(1).max(60).optional(),
  status: z.enum(STATUSES).optional(),
  // Present when the admin pastes a URL instead of uploading a file.
  coverImage: z.string().url().optional().or(z.literal("")),
});

export const updateBlogSchema = createBlogSchema.partial();
