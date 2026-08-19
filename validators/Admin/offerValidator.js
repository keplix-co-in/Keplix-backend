import { z } from 'zod';

// Same key rule as health components: lowercase machine keys, because client
// code references them literally.
const key = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9_]+$/, 'lowercase letters, numbers and underscores only');

/**
 * Text the admin can clear.
 *
 * `.nullish()`, not `.optional()`: the editor sends an explicitly cleared field
 * as `null` so it overwrites the stored value. `.optional()` only permits
 * `undefined`, so an emptied field was rejected with a 400 and the whole save
 * failed — which is what stopped the banner (with its optional background
 * image) from ever saving.
 */
const text = (max) => z.string().trim().max(max).nullish();

/**
 * A date the admin can clear.
 *
 * Bare `z.coerce.date()` coerces `null` to `new Date(null)` — 1st Jan 1970 —
 * so clearing both dates produced two epoch timestamps, failed the
 * "end after start" check below, and would otherwise have silently expired the
 * slot. Null is mapped through untouched and only real values are coerced.
 */
const dateField = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : v),
  z.union([z.null(), z.coerce.date()])
).optional();

const content = {
  label: z.string().trim().min(1).max(120),
  description: text(300),
  headline: text(60),
  body: text(300),
  badge_text: text(60),
  // Validated as a URL only when one is actually present.
  image_url: z.union([z.null(), z.string().trim().url().max(500)]).optional(),
  is_active: z.boolean().optional(),
  starts_at: dateField,
  ends_at: dateField,
  display_order: z.coerce.number().int().min(0).optional(),
};

// A window that ends before it starts would silently never show, with no error
// anywhere — the admin would just see nothing and have no idea why.
const windowIsOrdered = (d) => !d.starts_at || !d.ends_at || d.ends_at > d.starts_at;
const windowMessage = { message: 'The end date must be after the start date', path: ['ends_at'] };

export const createOfferSlotSchema = z
  .object({ key, ...content })
  .refine(windowIsOrdered, windowMessage);

// `key` is intentionally absent: client code references it, so renaming one
// would silently detach a live placement from its content.
export const updateOfferSlotSchema = z
  .object({ ...content, label: content.label.optional() })
  .refine(windowIsOrdered, windowMessage);

// Replaces the whole target set. An empty array is meaningful and allowed — it
// means "all vendors" (see the OfferSlotVendor comment in schema.prisma).
export const setOfferTargetsSchema = z.object({
  vendor_ids: z.array(z.coerce.number().int().positive()).max(500),
});
