// Scans a JSON response for the two shape bugs the 2026-09-26 audit found in
// util/publicVendor.js's stripVendorSecrets(): a Date with no own enumerable
// keys serializing as `{}`, and a Prisma Decimal serializing as its internal
// {s, e, d} fields instead of a number/string. Every module's flow test should
// run its responses through this — the bug can resurface anywhere
// stripVendorSecrets (or something like it) is added later.
//
// Usage:
//   import { scanForBrokenShapes } from './assertShape.mjs';
//   const problems = scanForBrokenShapes(res.json);
//   expect(problems).toEqual([]);

const isDecimalShape = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === 3 && (v.s === 1 || v.s === -1) &&
  Number.isFinite(v.e) && Array.isArray(v.d) && v.d.length > 0;

/**
 * @param {*} data - a JSON-parsed response body
 * @returns {string[]} human-readable paths of any broken shapes found, empty if clean
 */
export function scanForBrokenShapes(data, path = '$', limit = 40) {
  const out = [];
  const walk = (o, p) => {
    if (out.length >= limit) return;
    if (Array.isArray(o)) {
      o.slice(0, 30).forEach((v, i) => walk(v, `${p}[${i}]`));
      return;
    }
    if (o && typeof o === 'object') {
      const keys = Object.keys(o);
      // An empty object where a date/time/amount field is expected, going by its
      // own key name, is the tell — {} is also a legitimate value elsewhere
      // (an empty settings object, say), so this only flags suspicious keys.
      if (keys.length === 0 && /date|_at$|at$|time|price|amount/i.test(String(p).split(/[.[]/).pop())) {
        out.push(`${p} = {} (expected a value, got an empty object)`);
        return;
      }
      if (isDecimalShape(o)) {
        out.push(`${p} = ${JSON.stringify(o)} (looks like an unserialized Decimal)`);
        return;
      }
      keys.forEach((k) => walk(o[k], `${p}.${k}`));
    }
  };
  walk(data, path);
  return out;
}

export default scanForBrokenShapes;
