import { z } from "zod";

const vehicleSegmentField = z.enum(['HATCHBACK', 'SEDAN', 'COMPACT_SUV', 'MUV', 'LUXURY']);

/**
 * Accepts a field either as a JSON string or as the real value.
 *
 * multer runs before this validator on both routes, so a multipart request
 * (a save WITH an image -- see uploadSingle('image') in
 * routes/vendor/services.js) has already reduced every field to a string; a
 * plain JSON request (the partner portal saving WITHOUT an image) sends real
 * arrays. Pricing v2 (2026-11-20): every array field accepts both shapes.
 * '' means "empty list".
 */
const jsonOrValue = (fieldName) =>
  z.union([
    z.string().transform((v, ctx) => {
      if (v === '') return [];
      try {
        return JSON.parse(v);
      } catch {
        ctx.addIssue({ code: 'custom', message: `${fieldName} must be valid JSON` });
        return z.NEVER;
      }
    }),
    z.array(z.any()),
  ]);

/**
 * `segment_prices` — one price per selected vehicle segment.
 *
 * Entirely optional: a service submitted with no segment_prices at all keeps
 * working on `price` alone, exactly as it did before this field existed.
 * The field allows 0 here; the old "must be positive" rule still applies to a
 * LEGACY payload (no price_lines) through legacyPriceRules below. When
 * price_lines is present the server computes segment prices itself and
 * ignores these, so a ₹0 segment there must not fail validation.
 */
const segmentPricesField = jsonOrValue('segment_prices')
  .pipe(
    z
      .array(
        z.object({
          segment: vehicleSegmentField,
          price: z.coerce.number().nonnegative(),
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

// ---------------------------------------------------------------------------
// Pricing v2 fields (docs/PRICING_V2_API.md section 1)
// ---------------------------------------------------------------------------

const atMostTwoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

const priceLineSchema = z.object({
  segment: vehicleSegmentField.nullish().transform((v) => v ?? null),
  kind: z.enum(['labour', 'part']),
  name: z.string().trim().min(1).max(80),
  qty: z.coerce.number().positive().max(9999).refine(atMostTwoDecimals, { message: 'qty can have at most 2 decimals' }),
  unit_price: z.coerce.number().nonnegative().max(9999999).refine(atMostTwoDecimals, { message: 'unit_price can have at most 2 decimals' }),
});

// The 100-line cap is not in the contract; it only stops an absurd payload
// from writing thousands of rows in one request.
const priceLinesField = jsonOrValue('price_lines').pipe(z.array(priceLineSchema).max(100)).optional();

const textListField = (fieldName) =>
  jsonOrValue(fieldName).pipe(z.array(z.string().trim().min(1).max(80)).max(20)).optional();

// Multipart sends "true"/"false"; JSON sends a boolean.
const booleanField = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
  .optional();

// Multipart sends "299"; JSON sends 299. '' / null mean "not set".
const emptyToUndefined = (v) => (v === '' || v === null || v === 'null' ? undefined : v);
const optionalMoneyField = z.preprocess(
  emptyToUndefined,
  z.coerce.number().nonnegative().max(9999999).refine(atMostTwoDecimals, { message: 'At most 2 decimals' }).optional()
);

// Optional at the field level on BOTH schemas: required (and positive) for a
// legacy create, ignored when price_lines is present -- see legacyPriceRules.
const priceField = z.preprocess(emptyToUndefined, z.coerce.number().nonnegative().optional());

const pricingFields = {
  pricing_type: z.enum(['fixed', 'starting', 'inspection']).optional(),
  price_lines: priceLinesField,
  inclusions: textListField('inclusions'),
  exclusions: textListField('exclusions'),
  price_change_note: z.string().trim().max(300).nullish(),
  inspection_fee: optionalMoneyField,
  tax_inclusive: booleanField,
};

/**
 * The pricing-type rules from section 1, checked on the FULL pricing state
 * (for an update: the body merged with the stored service, done in
 * controllers/vendor/serviceController.js). Returns [{ path, message }];
 * empty = valid.
 *
 * @param {{pricing_type?:string, price_lines?:Array<{segment:any}>, inclusions?:string[], inspection_fee?:number|null}} p
 */
export const checkPricingRules = ({ pricing_type, price_lines, inclusions, inspection_fee }) => {
  const issues = [];
  const type = pricing_type ?? 'fixed';
  if (type === 'starting' && (inclusions ?? []).length < 1) {
    issues.push({ path: ['inclusions'], message: "A 'starting' price needs at least one inclusion" });
  }
  if (type === 'inspection' && (inspection_fee === undefined || inspection_fee === null)) {
    issues.push({ path: ['inspection_fee'], message: "An 'inspection' service needs an inspection_fee (0 is allowed)" });
  }
  if ((type === 'fixed' || type === 'starting') && !(price_lines ?? []).some((l) => !l.segment)) {
    issues.push({ path: ['price_lines'], message: `A '${type}' price needs at least one base line (segment: null)` });
  }
  return issues;
};

/**
 * A legacy payload (no price_lines) keeps the old rules: `price` positive
 * and every segment price positive. Applied only when price_lines is absent;
 * with price_lines the server derives both and a client 0 is harmless.
 */
const legacyPriceRules = (body, ctx, { priceRequired }) => {
  if (Array.isArray(body.price_lines) || body.pricing_type === 'inspection') return;
  if (priceRequired && body.price === undefined) {
    ctx.addIssue({ code: 'custom', path: ['price'], message: 'Price is required' });
  }
  if (body.price !== undefined && !(body.price > 0)) {
    ctx.addIssue({ code: 'custom', path: ['price'], message: 'Price must be positive' });
  }
  for (const [i, sp] of (body.segment_prices ?? []).entries()) {
    if (!(sp.price > 0)) {
      ctx.addIssue({ code: 'custom', path: ['segment_prices', i, 'price'], message: 'Segment price must be positive' });
    }
  }
};

export const createServiceSchema = z
  .object({
    name: z.string().min(1, { message: "Service name is required" }),
    // Owner 2026-11-21: description is optional (garages may leave it blank).
    // The DB column is non-null, so a missing one is stored as "".
    description: z.string().trim().max(2000).optional().default(""),
    price: priceField,
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
    ...pricingFields,
  })
  .superRefine((body, ctx) => {
    legacyPriceRules(body, ctx, { priceRequired: true });
    const legacy = !Array.isArray(body.price_lines) && body.pricing_type !== 'inspection';
    for (const issue of checkPricingRules({
      ...body,
      // A legacy create always gets a synthesised base line from `price`.
      price_lines: legacy ? [{ segment: null }] : body.price_lines,
    })) {
      ctx.addIssue({ code: 'custom', ...issue });
    }
    // A legacy payload is stored as 'fixed' (contract section 1), so
    // 'starting' without real lines would silently lose its type.
    if (legacy && body.pricing_type === 'starting') {
      ctx.addIssue({ code: 'custom', path: ['price_lines'], message: "A 'starting' price needs price_lines" });
    }
  });

// Update: every field optional; the pricing-type rules are checked against
// the merged state in the controller (checkPricingRules), because whether
// e.g. a base line exists depends on what is already stored.
export const updateServiceSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().trim().max(2000).optional(),
    price: priceField,
    duration: z.coerce.number().int().positive().optional(),
    category: z.string().optional(),
    image: z.string().optional(),
    // The controller has always read is_active on update, but this schema left it
    // out, and zod drops unknown keys — so pausing or resuming a service returned
    // 200 while changing nothing. Declared the same way as on create.
    is_active: z
      .preprocess((val) => val === "true" || val === true, z.boolean())
      .optional(),
    segment_prices: segmentPricesField,
    vehicle_note: z.string().trim().max(200).nullish(),
    ...pricingFields,
  })
  .superRefine((body, ctx) => legacyPriceRules(body, ctx, { priceRequired: false }));
