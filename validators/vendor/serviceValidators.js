import { z } from "zod";

const vehicleSegmentField = z.enum(['HATCHBACK', 'SEDAN', 'COMPACT_SUV', 'MUV', 'LUXURY']);

/**
 * `segment_prices` — one price per selected vehicle segment.
 *
 * multer runs before this validator on both routes, so a multipart request
 * (the app's actual create/update path — see uploadSingle('image') in
 * routes/vendor/services.js) has already reduced every field to a string;
 * an array only arrives as-is on a plain JSON request. Accepting both means
 * the same schema works whichever the client sends.
 *
 * Entirely optional: a service submitted with no segment_prices at all keeps
 * working on `price` alone, exactly as it did before this field existed.
 */
const segmentPricesField = z
  .union([
    z.string().transform((v, ctx) => {
      if (v === '' || v === undefined) return [];
      try {
        return JSON.parse(v);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'segment_prices must be valid JSON' });
        return z.NEVER;
      }
    }),
    z.array(z.any()),
  ])
  .pipe(
    z
      .array(
        z.object({
          segment: vehicleSegmentField,
          price: z.coerce.number().positive(),
        })
      )
      // A vendor picking the same segment twice would leave the DB write
      // (an upsert keyed on [serviceId, segment]) to silently pick whichever
      // came last — reject it here instead, where the vendor gets a clear
      // error pointing at their own form.
      .refine(
        (rows) => new Set(rows.map((r) => r.segment)).size === rows.length,
        { message: 'Each vehicle segment can only have one price' }
      )
  )
  .optional();

export const createServiceSchema = z.object({
  name: z.string().min(1, { message: "Service name is required" }),
  description: z.string().min(1, { message: "Description is required" }),
  price: z.coerce.number().positive({ message: "Price must be positive" }),
  duration: z.coerce
    .number()
    .int()
    .positive({ message: "Duration must be positive (minutes)" }),
  category: z.string().min(1, { message: "Category is required" }),
  image: z.string().optional(),
  is_active: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .optional(),
  segment_prices: segmentPricesField,
  vehicle_note: z.string().trim().max(200).nullish(),
});

export const updateServiceSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  price: z.coerce.number().positive().optional(),
  duration: z.coerce.number().int().positive().optional(),
  category: z.string().optional(),
  image: z.string().optional(),
  segment_prices: segmentPricesField,
  vehicle_note: z.string().trim().max(200).nullish(),
});
