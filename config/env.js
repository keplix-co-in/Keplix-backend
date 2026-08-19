import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().optional(),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),

  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),

  CLOUDINARY_URL: z.string().min(1, "CLOUDINARY_URL is required"),

  // No REDIS_* vars: Redis was removed entirely. Background jobs live in
  // Postgres (util/jobQueue.js) and the token blacklist is a table
  // (middleware/authMiddleware.js), so DATABASE_URL is the only datastore
  // config this app needs. Leftover REDIS_* values in the environment are
  // ignored -- z.object() strips undeclared keys -- and can be deleted.

  // "false" keeps background job dispatching out of this process. See server.js.
  // Declared here because z.object() STRIPS undeclared keys -- reading
  // env.RUN_WORKERS without this line would always be undefined.
  RUN_WORKERS: z.string().optional(),
});

export const env = envSchema.parse(process.env);