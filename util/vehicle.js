/**
 * Canonical registration form: uppercased, whitespace stripped. The Zod
 * schema (validators/vendor/walkInJobValidators.js) already does this on the
 * HTTP path, but the vehicle_reg_per_vendor uniqueness this feeds only works
 * if every writer normalises identically — trusting the validator alone means
 * a future caller that bypasses it (an admin import script, a different
 * route) silently creates a duplicate Vehicle for the same plate. Normalise
 * again here, at the point the DB write actually happens.
 */
export function normalizeRegistration(input) {
  if (typeof input !== 'string') return input;
  return input.replace(/\s+/g, '').toUpperCase();
}
