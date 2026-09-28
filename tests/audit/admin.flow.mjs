process.env.AUDIT_DB_NAME = 'keplix_audit_admin';
const { seed } = await import('./seed.mjs');
const { scanForBrokenShapes } = await import('./assertShape.mjs');
const { prisma, bcrypt, call, token, adminToken, listRoutes, shutdown } = await import('./harness.mjs');

let pass = 0, fail = 0;
const results = [];

function check(name, cond, extra) {
  if (cond) { pass++; results.push(`PASS  ${name}`); }
  else { fail++; results.push(`FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
}

async function main() {
  const ids = await seed(prisma, bcrypt);
  const admin = adminToken(ids.admin.id);
  const userTok = token(ids.customer.id);

  // Root admin seeded with role 'admin'; several routes (force-complete,
  // dispute/resolve, payout settle, refund) require 'super_admin'.
  const superAdmin = await prisma.admin.create({
    data: { name: 'Super Admin', email: 'super@audit.test', password: await bcrypt.hash('AdminPass1!', 4), role: 'super_admin', status: 'ACTIVE' },
  });
  const superTok = adminToken(superAdmin.id);

  // ---- AUTH ----
  const loginRes = await call('POST', '/admin/auth/login', { body: { email: 'root@audit.test', password: 'AdminPass1!' } });
  check('POST /admin/auth/login 200', loginRes.status === 200, JSON.stringify(loginRes.json));
  check('login returns accessToken/refreshToken', !!loginRes.json?.accessToken && !!loginRes.json?.refreshToken);
  check('login response shape clean', scanForBrokenShapes(loginRes.json).length === 0, scanForBrokenShapes(loginRes.json).join(';'));

  const badLogin = await call('POST', '/admin/auth/login', { body: { email: 'root@audit.test', password: 'wrong' } });
  check('bad password -> 401', badLogin.status === 401, badLogin.status);

  const rToken = loginRes.json?.refreshToken;
  const refreshRes = await call('POST', '/admin/auth/refresh', { body: { refreshToken: rToken } });
  check('POST /admin/auth/refresh 200', refreshRes.status === 200, JSON.stringify(refreshRes.json));

  const logoutRes = await call('POST', '/admin/auth/logout', { body: { refreshToken: refreshRes.json?.refreshToken } });
  check('POST /admin/auth/logout 200', logoutRes.status === 200, JSON.stringify(logoutRes.json));

  // A plain user token must not work as admin auth
  const userAsAdmin = await call('GET', '/admin/dashboard/metrics', { as: userTok });
  check('user token rejected on admin route', userAsAdmin.status === 401 || userAsAdmin.status === 403, userAsAdmin.status);

  // ---- DASHBOARD ----
  const metrics = await call('GET', '/admin/dashboard/metrics', { as: admin });
  check('GET /admin/dashboard/metrics 200', metrics.status === 200, JSON.stringify(metrics.json));
  check('dashboard metrics shape clean', scanForBrokenShapes(metrics.json).length === 0, scanForBrokenShapes(metrics.json).join(';'));

  for (const type of ['gmv', 'bookings', 'users', 'vendors', 'revenue', 'payouts']) {
    const r = await call('GET', `/admin/dashboard/revenue?type=${type}`, { as: admin });
    check(`GET /admin/dashboard/revenue?type=${type} 200`, r.status === 200, JSON.stringify(r.json).slice(0, 200));
    check(`revenue?type=${type} shape clean`, scanForBrokenShapes(r.json).length === 0, scanForBrokenShapes(r.json).join(';'));
  }

  // ---- BOOKINGS ----
  const bookingCounts = await call('GET', '/admin/bookings/counts', { as: admin });
  check('GET /admin/bookings/counts 200', bookingCounts.status === 200, JSON.stringify(bookingCounts.json));

  const bookingsList = await call('GET', '/admin/bookings', { as: admin });
  check('GET /admin/bookings 200', bookingsList.status === 200, JSON.stringify(bookingsList.json).slice(0, 200));
  check('bookings list shape clean', scanForBrokenShapes(bookingsList.json).length === 0, scanForBrokenShapes(bookingsList.json).join(';'));

  // Create a booking to exercise force-complete/dispute-resolve
  const service = ids.services[0];
  const booking = await prisma.booking.create({
    data: {
      userId: ids.customer.id,
      serviceId: service.id,
      status: 'in_progress',
      booking_date: new Date(),
      booking_time: '10:00',
    },
  });

  const forceCompleteAsAdmin = await call('POST', `/admin/bookings/${booking.id}/force-complete`, { as: admin, body: { reason: 'should be denied' } });
  check('force-complete denied for non-super_admin (403)', forceCompleteAsAdmin.status === 403, forceCompleteAsAdmin.status);

  const forceComplete = await call('POST', `/admin/bookings/${booking.id}/force-complete`, { as: superTok, body: { reason: 'audit test' } });
  check('POST force-complete 200 (super_admin)', forceComplete.status === 200, JSON.stringify(forceComplete.json));

  // Re-running force-complete on a booking already at 'service_completed' is
  // safe/idempotent by design (same status re-written, notes appended) --
  // the ALREADY_RESOLVED guard exists for cancelled/user_confirmed/completed,
  // states genuinely incompatible with re-forcing, not for its own output state.
  const forceCompleteAgain = await call('POST', `/admin/bookings/${booking.id}/force-complete`, { as: superTok, body: { reason: 'again' } });
  check('re-running force-complete on service_completed booking stays 200 (idempotent)', forceCompleteAgain.status === 200, forceCompleteAgain.status);

  const cancelledBooking = await prisma.booking.create({
    data: { userId: ids.customer.id, serviceId: service.id, status: 'cancelled', booking_date: new Date(), booking_time: '12:00' },
  });
  const forceCompleteCancelled = await call('POST', `/admin/bookings/${cancelledBooking.id}/force-complete`, { as: superTok, body: { reason: 'should be blocked' } });
  check('force-complete on cancelled booking -> 400 (blocked)', forceCompleteCancelled.status === 400, forceCompleteCancelled.status);

  const disputedBooking = await prisma.booking.create({
    data: { userId: ids.customer.id, serviceId: service.id, status: 'disputed', booking_date: new Date(), booking_time: '11:00' },
  });
  const disputeResolve = await call('POST', `/admin/bookings/${disputedBooking.id}/dispute/resolve`, { as: superTok, body: { reason: 'refund customer, garage no-show' } });
  check('POST dispute/resolve 200 (super_admin)', disputeResolve.status === 200, JSON.stringify(disputeResolve.json));

  // ---- USERS ----
  const userMetrics = await call('GET', '/admin/users/metrics', { as: admin });
  check('GET /admin/users/metrics 200', userMetrics.status === 200, JSON.stringify(userMetrics.json));

  const userList = await call('GET', '/admin/users', { as: admin });
  check('GET /admin/users 200', userList.status === 200, JSON.stringify(userList.json).slice(0, 200));
  check('users list shape clean', scanForBrokenShapes(userList.json).length === 0, scanForBrokenShapes(userList.json).join(';'));

  const deleteNoHistoryUser = await prisma.user.create({ data: { email: 'nohist@audit.test', password: 'x', role: 'user', is_active: true } });
  const delDeniedNonSuper = await call('DELETE', `/admin/users/${deleteNoHistoryUser.id}`, { as: admin });
  check('DELETE user denied for non-super_admin (403)', delDeniedNonSuper.status === 403, delDeniedNonSuper.status);

  const delRes = await call('DELETE', `/admin/users/${deleteNoHistoryUser.id}`, { as: superTok });
  check('DELETE user (no history) 200', delRes.status === 200, JSON.stringify(delRes.json));

  const delWithHistory = await call('DELETE', `/admin/users/${ids.customer.id}`, { as: superTok });
  check('DELETE user (with booking history) 200 (soft-erase)', delWithHistory.status === 200, JSON.stringify(delWithHistory.json));

  // ---- VENDORS ----
  const vendorMetrics = await call('GET', '/admin/vendors/metrics', { as: admin });
  check('GET /admin/vendors/metrics 200', vendorMetrics.status === 200, JSON.stringify(vendorMetrics.json));

  const vendorList = await call('GET', '/admin/vendors', { as: admin });
  check('GET /admin/vendors 200', vendorList.status === 200, JSON.stringify(vendorList.json).slice(0, 300));
  check('vendors list shape clean', scanForBrokenShapes(vendorList.json).length === 0, scanForBrokenShapes(vendorList.json).join(';'));

  // Re-verify the already-fixed approve-vendor bug (should NOT 500, should select business_name not shop_name)
  const approve = await call('PATCH', `/admin/vendors/${ids.vendor2.id}/status`, { as: admin, body: { status: 'approved', reason: 'audit re-verify' } });
  check('PATCH vendor status (approve pending vendor) 200, not 500', approve.status === 200, JSON.stringify(approve.json));
  check('approve response has business_name (not shop_name/undefined)', approve.json?.vendor?.business_name === 'Pending Garage', JSON.stringify(approve.json));

  const approveNoop = await call('PATCH', `/admin/vendors/${ids.vendor2.id}/status`, { as: admin, body: { status: 'approved' } });
  check('re-approving already-approved vendor is a no-op 200', approveNoop.status === 200, JSON.stringify(approveNoop.json));

  const approveUnknown = await call('PATCH', `/admin/vendors/999999/status`, { as: admin, body: { status: 'approved' } });
  check('approving unknown vendor -> 404', approveUnknown.status === 404, approveUnknown.status);

  // ---- FINANCE ----
  const financeKpis = await call('GET', '/admin/finance/kpis', { as: admin });
  check('GET /admin/finance/kpis 200', financeKpis.status === 200, JSON.stringify(financeKpis.json));
  check('finance kpis shape clean', scanForBrokenShapes(financeKpis.json).length === 0, scanForBrokenShapes(financeKpis.json).join(';'));

  const payouts = await call('GET', '/admin/finance/payouts', { as: admin });
  check('GET /admin/finance/payouts 200', payouts.status === 200, JSON.stringify(payouts.json).slice(0, 300));
  check('payouts shape clean', scanForBrokenShapes(payouts.json).length === 0, scanForBrokenShapes(payouts.json).join(';'));

  // settle/refund are super_admin-only, money-moving actions; verify the
  // privilege gate holds and that a nonexistent payment 404s cleanly rather
  // than 500ing (no real Razorpay call is reachable in this harness).
  const settleDenied = await call('POST', '/admin/finance/payouts/999999/settle', { as: admin });
  check('settle denied for non-super_admin (403)', settleDenied.status === 403, settleDenied.status);
  const settleUnknown = await call('POST', '/admin/finance/payouts/999999/settle', { as: superTok });
  check('settle on unknown payment -> 4xx (not 500)', settleUnknown.status >= 400 && settleUnknown.status < 500, settleUnknown.status);

  const refundDenied = await call('POST', '/admin/finance/payments/999999/refund', { as: admin, body: { idempotencyKey: 'audit-1' } });
  check('refund denied for non-super_admin (403)', refundDenied.status === 403, refundDenied.status);
  const refundUnknown = await call('POST', '/admin/finance/payments/999999/refund', { as: superTok, body: { idempotencyKey: 'audit-1' } });
  check('refund on unknown payment -> 4xx (not 500)', refundUnknown.status >= 400 && refundUnknown.status < 500, refundUnknown.status);

  // ---- BLOG ----
  const blogList = await call('GET', '/admin/blogs', { as: admin });
  check('GET /admin/blogs 200', blogList.status === 200, JSON.stringify(blogList.json).slice(0, 200));
  check('blogs list shape clean', scanForBrokenShapes(blogList.json).length === 0, scanForBrokenShapes(blogList.json).join(';'));

  const createBlog = await call('POST', '/admin/blogs', { as: admin, body: { title: 'Audit Post', excerpt: 'e', content: '<p>hi</p>', category: 'General', status: 'draft' } });
  check('POST /admin/blogs 201', createBlog.status === 201, JSON.stringify(createBlog.json));

  const blogId = createBlog.json?.id;
  if (blogId) {
    const getBlog = await call('GET', `/admin/blogs/${blogId}`, { as: admin });
    check('GET /admin/blogs/:id 200', getBlog.status === 200, JSON.stringify(getBlog.json).slice(0, 200));

    const updateBlog = await call('PUT', `/admin/blogs/${blogId}`, { as: admin, body: { status: 'published' } });
    check('PUT /admin/blogs/:id 200', updateBlog.status === 200, JSON.stringify(updateBlog.json).slice(0, 200));

    const deleteBlog = await call('DELETE', `/admin/blogs/${blogId}`, { as: admin });
    check('DELETE /admin/blogs/:id 200', deleteBlog.status === 200, JSON.stringify(deleteBlog.json));
  }

  // ---- WALK-IN JOBS ----
  const walkInList = await call('GET', '/admin/walk-in-jobs', { as: admin });
  check('GET /admin/walk-in-jobs 200', walkInList.status === 200, JSON.stringify(walkInList.json).slice(0, 300));
  check('walk-in jobs list shape clean', scanForBrokenShapes(walkInList.json).length === 0, scanForBrokenShapes(walkInList.json).join(';'));

  const adoption = await call('GET', '/admin/walk-in-jobs/adoption', { as: admin });
  check('GET /admin/walk-in-jobs/adoption 200', adoption.status === 200, JSON.stringify(adoption.json).slice(0, 300));
  check('adoption shape clean', scanForBrokenShapes(adoption.json).length === 0, scanForBrokenShapes(adoption.json).join(';'));

  // detail on unknown id
  const walkInDetail404 = await call('GET', '/admin/walk-in-jobs/999999', { as: admin });
  check('GET /admin/walk-in-jobs/:id (unknown) 404', walkInDetail404.status === 404, walkInDetail404.status);

  // ---- HEALTH COMPONENTS ----
  const hcList = await call('GET', '/admin/health-components', { as: admin });
  check('GET /admin/health-components 200', hcList.status === 200, JSON.stringify(hcList.json).slice(0, 200));

  const hcKey = `audit_wipers_${Date.now()}`;
  const hcCreate = await call('POST', '/admin/health-components', { as: admin, body: { key: hcKey, label: 'Wipers', display_order: 1 } });
  check('POST /admin/health-components 201', hcCreate.status === 201, JSON.stringify(hcCreate.json));

  const hcId = hcCreate.json?.component?.id;
  if (hcId) {
    const hcUpdate = await call('PATCH', `/admin/health-components/${hcId}`, { as: admin, body: { label: 'Wipers Updated', is_active: false } });
    check('PATCH /admin/health-components/:id 200', hcUpdate.status === 200, JSON.stringify(hcUpdate.json));
  }

  // ---- OFFER SLOTS ----
  const offerList = await call('GET', '/admin/offer-slots', { as: admin });
  check('GET /admin/offer-slots 200', offerList.status === 200, JSON.stringify(offerList.json).slice(0, 300));
  check('offer slots shape clean', scanForBrokenShapes(offerList.json).length === 0, scanForBrokenShapes(offerList.json).join(';'));

  const offerCreate = await call('POST', '/admin/offer-slots', { as: admin, body: { key: 'audit_slot', label: 'Audit Slot', is_active: true } });
  check('POST /admin/offer-slots 201', offerCreate.status === 201, JSON.stringify(offerCreate.json));

  const offerId = offerCreate.json?.slot?.id;
  if (offerId) {
    const offerUpdate = await call('PATCH', `/admin/offer-slots/${offerId}`, { as: admin, body: { headline: '10% off' } });
    check('PATCH /admin/offer-slots/:id 200', offerUpdate.status === 200, JSON.stringify(offerUpdate.json));

    const offerTargets = await call('PUT', `/admin/offer-slots/${offerId}/targets`, { as: admin, body: { vendor_ids: [ids.vendor.id] } });
    check('PUT /admin/offer-slots/:id/targets 200', offerTargets.status === 200, JSON.stringify(offerTargets.json));

    const badTargets = await call('PUT', `/admin/offer-slots/${offerId}/targets`, { as: admin, body: { vendor_ids: [999999] } });
    check('PUT targets with invalid vendor -> 400', badTargets.status === 400, badTargets.status);

    const upsert = await call('PUT', `/admin/offer-slots/by-key/audit_slot`, { as: admin, body: { headline: 'Updated headline' } });
    check('PUT /admin/offer-slots/by-key/:key 200', upsert.status === 200, JSON.stringify(upsert.json));

    const offerDelete = await call('DELETE', `/admin/offer-slots/${offerId}`, { as: admin });
    check('DELETE /admin/offer-slots/:id 200', offerDelete.status === 200, JSON.stringify(offerDelete.json));
  }

  // ---- PLATFORM SETTINGS ----
  const settingsGet = await call('GET', '/admin/platform-settings', { as: admin });
  check('GET /admin/platform-settings 200', settingsGet.status === 200, JSON.stringify(settingsGet.json));
  check('platform settings shape clean', scanForBrokenShapes(settingsGet.json).length === 0, scanForBrokenShapes(settingsGet.json).join(';'));

  const settingsUpdate = await call('PATCH', '/admin/platform-settings', { as: admin, body: { platformFeePercentage: 0.12 } });
  check('PATCH /admin/platform-settings 200', settingsUpdate.status === 200, JSON.stringify(settingsUpdate.json));

  // ---- Route enumeration sanity ----
  const routes = listRoutes().filter((r) => r.path.startsWith('/admin'));
  check('admin routes are registered', routes.length > 10, routes.length);

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);

  await shutdown();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
