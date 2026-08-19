import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().optional(),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),

  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),

  CLOUDINARY_URL: z.string().min(1, "CLOUDINARY_URL is required"),

  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.string().default("6379"),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z.string().optional(),
});

export const env = envSchema.parse(process.env);