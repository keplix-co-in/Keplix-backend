import { z } from 'zod';

/**
 * Multipart body: every scalar arrives as a string, and `items` arrives as a
 * JSON string rather than a real array — z.preprocess turns it back into one
 * before validation runs. bookingId/walkInJobId are mutually exclusive
 * (exactly one), mirroring the DB CHECK constraint on HealthSheet so a bad
 * request is a clean 400 rather than a raw Postgres constraint error.
 *
 * Completeness (every active component present, exactly once) is checked in
 * the controller against the live HealthComponent table, not here — the set
 * of required keys can change at runtime and this schema must not hardcode
 * it.
 */
export const createHealthSheetSchema = z
  .object({
    bookingId: z.coerce.number().int().positive().optional(),
    walkInJobId: z.coerce.number().int().positive().optional(),
    odometer_km: z.coerce.number().int().min(0).optional(),
    overall_notes: z.string().trim().max(2000).optional(),
    items: z.preprocess(
      (v) => {
        if (typeof v !== 'string') return v;
        try {
          return JSON.parse(v);
        } catch {
          return v; // let the array check below produce the real error
        }
      },
      z
        .array(
          z.object({
            // Exactly one of these identifies the item — a fixed inspection
            // component (booking path) or a service chosen on a walk-in. The
            // controller enforces the XOR, since which one is valid depends on
            // the parent job.
            component_key: z.string().min(1).optional(),
            walk_in_service_id: z.coerce.number().int().positive().optional(),
            // Optional so "skip" can write a sheet with no detail filled in,
            // which is what stops the mandatory-inspection gate stranding a job.
            status: z.enum(['GOOD', 'ATTENTION', 'REPLACE']).optional(),
            price: z.coerce.number().nonnegative().optional(),
            notes: z.string().trim().max(500).optional(),
          }),
        )
        .min(1, 'At least one inspection item is required'),
    ),
  })
  .refine((d) => Boolean(d.bookingId) !== Boolean(d.walkInJobId), {
    message: 'Provide exactly one of bookingId or walkInJobId',
    path: ['bookingId'],
  })
  .refine(
    (d) => {
      // Keyed off whichever identifier the item carries, so duplicates are
      // still caught for both kinds.
      const keys = d.items.map((i) => i.component_key ?? `svc-${i.walk_in_service_id}`);
      return new Set(keys).size === keys.length;
    },
    { message: 'Duplicate item', path: ['items'] },
  );
