/**
 * Audit 2026-11-07: self-registered vendors are 'pending' until approved.
 * Money / booking-accept / job actions must carry requireApprovedVendor;
 * profile, onboarding and listing editing must NOT (vendors need them before
 * approval). Static check of the route files so a future edit that drops or
 * adds a gate fails loudly.
 */
import fs from 'fs';

const lines = (f) => fs.readFileSync(new URL(`../../routes/vendor/${f}`, import.meta.url), 'utf8').split(/\r?\n/);
const routeLine = (f, method, path) => {
  const l = lines(f);
  const i = l.findIndex((x) => x.includes(`router.${method}(`) && x.includes(`'${path}'`));
  if (i >= 0) return l[i];
  // multi-line router.patch(\n '/path', ...)
  const j = l.findIndex((x, k) => x.includes(`'${path}'`) && l[k - 1]?.includes(`router.${method}(`));
  return l.slice(j - 1, j + 8).join(' ');
};

describe('vendor routes: approval gates', () => {
  test.each([
    ['bookings.js', 'patch', '/bookings/:id/respond'],
    ['bookings.js', 'patch', '/:vendorId/bookings/:id/respond'],
    ['bookings.js', 'post', '/:vendorId/bookings/update/:id'],
    ['bookings.js', 'patch', '/:vendorId/bookings/update/:id'],
    ['bookings.js', 'post', '/:vendorId/bookings/:id/early-start'],
    ['payments.js', 'post', '/vendor/payments/order/create'],
    ['payments.js', 'post', '/vendor/payments/verify'],
    ['walkInJobs.js', 'post', '/walk-in-jobs'],
    ['walkInJobs.js', 'patch', '/walk-in-jobs/:id'],
    ['walkInJobs.js', 'patch', '/walk-in-jobs/:id/status'],
    ['walkInJobs.js', 'post', '/walk-in-jobs/:id/notify'],
    ['healthSheets.js', 'post', '/health-sheets'],
  ])('%s %s %s is gated', (f, m, p) => {
    expect(routeLine(f, m, p)).toContain('requireApprovedVendor');
  });

  test.each([
    ['profile.js', 'get', '/'], ['profile.js', 'put', '/'], ['profile.js', 'patch', '/'], ['profile.js', 'post', '/'],
    ['documents.js', 'post', '/'],
    ['services.js', 'post', '/:vendorId/services/create'],
    ['services.js', 'put', '/:vendorId/services/update/:id'],
    ['availability.js', 'post', '/vendor/:vendorId/availability/create'],
  ])('%s %s %s stays open for onboarding', (f, m, p) => {
    const l = routeLine(f, m, p);
    expect(l).toContain('vendorOnly');
    expect(l).not.toContain('requireApprovedVendor');
  });
});
