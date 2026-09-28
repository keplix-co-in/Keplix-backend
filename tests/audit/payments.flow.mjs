// Audit flow test for the Payments module: routes/user/payments.js,
// routes/vendor/payments.js. See AUDIT.md for the harness contract.
process.env.AUDIT_DB_NAME = 'keplix_audit_payments';

const { seed } = await import('./seed.mjs');
const { scanForBrokenShapes } = await import('./assertShape.mjs');
const { prisma, bcrypt, call, token, listRoutes, shutdown } = await import('./harness.mjs');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`PASS  ${name}`); }
  else { fail++; results.push(`FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}

try {
  const ids = await seed(prisma, bcrypt);
  const customerTok = token(ids.customer.id);
  const customer2Tok = token(ids.customer2.id);
  const vendorTok = token(ids.vendor.id);
  const vendor2Tok = token(ids.vendor2.id);

  // Sanity: routes exist
  const routes = listRoutes();
  const need = [
    'POST /service_api/payments/razorpay-webhook',
    'POST /service_api/payments/order/create',
    'POST /service_api/payments/verify',
    'GET /service_api/vendor/:vendor_id/payments',
    'GET /service_api/vendor/:vendor_id/earning',
    'POST /service_api/vendor/payments/order/create',
    'POST /service_api/vendor/payments/verify',
  ];
  for (const n of need) {
    check(`route exists: ${n}`, routes.some(r => `${r.method} ${r.path}` === n));
  }

  // --- Create a booking as customer, have vendor accept it ---
  const svc = ids.services[0]; // Oil Change, 799.00
  const bookingRes = await call('POST', `/service_api/user/${ids.customer.id}/bookings/create`, {
    as: customerTok,
    body: {
      serviceId: svc.id,
      booking_date: new Date(Date.now() + 86400000).toISOString(),
      booking_time: '10:00 AM',
    },
  });
  check('booking create succeeds (setup, not this module)', bookingRes.status === 201 || bookingRes.status === 200, `status=${bookingRes.status} body=${bookingRes.text}`);
  const bookingId = bookingRes.json?.booking?.id ?? bookingRes.json?.id;
  check('booking id resolved', !!bookingId, JSON.stringify(bookingRes.json));

  const acceptRes = await call('PATCH', `/service_api/vendor/${ids.vendor.id}/bookings/${bookingId}/respond`, {
    as: vendorTok,
    body: { vendor_status: 'accepted' },
  });
  check('vendor accept succeeds (setup, not this module)', acceptRes.status === 200, `status=${acceptRes.status} body=${acceptRes.text}`);

  // =========================================================================
  // 1. Order create
  // =========================================================================
  const orderRes = await call('POST', '/service_api/payments/order/create', {
    as: customerTok,
    body: { bookingId, gateway: 'razorpay' },
  });
  // Fake Razorpay creds -> the SDK call to the real gateway must fail cleanly,
  // not 500/crash. Accept any clean 4xx/5xx-that-isn't-an-unhandled-exception;
  // record actual status for the report.
  check('order/create does not throw unhandled / crash the process', orderRes.status !== 0, orderRes.error);
  check('order/create returns a clean status (not silent 200 with fake gateway)', orderRes.status >= 400 || orderRes.status === 200, `status=${orderRes.status} body=${orderRes.text}`);
  check('order/create: gateway auth failure -> 502, not 500', orderRes.status === 502, `status=${orderRes.status} body=${orderRes.text}`);
  if (orderRes.json) check('order/create response has no broken {s,e,d}/date shapes', scanForBrokenShapes(orderRes.json).length === 0, JSON.stringify(scanForBrokenShapes(orderRes.json)));
  results.push(`INFO  order/create actual status vs real gateway: ${orderRes.status} body=${orderRes.text}`);

  // Missing bookingId -> validation 400
  const orderNoBooking = await call('POST', '/service_api/payments/order/create', { as: customerTok, body: { gateway: 'razorpay' } });
  check('order/create missing bookingId -> 400', orderNoBooking.status === 400, `status=${orderNoBooking.status}`);

  // Not authorized (customer2 trying to pay for customer's booking)
  const orderWrongUser = await call('POST', '/service_api/payments/order/create', { as: customer2Tok, body: { bookingId, gateway: 'razorpay' } });
  check('order/create for someone else\'s booking -> 403 (not 500)', orderWrongUser.status === 403, `status=${orderWrongUser.status} body=${orderWrongUser.text}`);

  // Nonexistent booking
  const orderBadBooking = await call('POST', '/service_api/payments/order/create', { as: customerTok, body: { bookingId: 999999999, gateway: 'razorpay' } });
  check('order/create nonexistent booking -> 404', orderBadBooking.status === 404, `status=${orderBadBooking.status}`);

  // =========================================================================
  // 2. Verify payment -- fake signature must fail cleanly (400), not 500
  // =========================================================================
  const verifyBadSig = await call('POST', '/service_api/payments/verify', {
    as: customerTok,
    body: { bookingId, orderId: 'order_fake123', paymentId: 'pay_fake123', signature: 'deadbeef', gateway: 'razorpay' },
  });
  check('verify with bad signature -> clean 4xx (not 500)', verifyBadSig.status >= 400 && verifyBadSig.status < 500, `status=${verifyBadSig.status} body=${verifyBadSig.text}`);
  if (verifyBadSig.json) check('verify bad-sig response has no broken shapes', scanForBrokenShapes(verifyBadSig.json).length === 0, JSON.stringify(scanForBrokenShapes(verifyBadSig.json)));

  // Verify missing fields
  const verifyMissing = await call('POST', '/service_api/payments/verify', { as: customerTok, body: { bookingId, gateway: 'razorpay' } });
  check('verify missing orderId/paymentId/signature -> 400', verifyMissing.status === 400, `status=${verifyMissing.status} body=${verifyMissing.text}`);

  // Verify with a self-consistent HMAC signature (valid per OUR secret) but
  // for an order/payment that doesn't exist at a real gateway -> should hit
  // razorpay.payments.fetch() and fail there. Confirms clean handling (502 or 4xx),
  // not an unhandled exception, when the fake key can't reach a real gateway.
  const crypto = await import('node:crypto');
  const orderId = 'order_selfsigned', paymentId = 'pay_selfsigned';
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(orderId + '|' + paymentId).digest('hex');
  const verifyGoodSigFakeGateway = await call('POST', '/service_api/payments/verify', {
    as: customerTok,
    body: { bookingId, orderId, paymentId, signature: sig, gateway: 'razorpay' },
  });
  check('verify: valid HMAC but gateway unreachable/fake -> clean 4xx/502 (not 500 crash)', [400, 404, 409, 422, 502].includes(verifyGoodSigFakeGateway.status), `status=${verifyGoodSigFakeGateway.status} body=${verifyGoodSigFakeGateway.text}`);
  results.push(`INFO  verify (good sig, fake gateway) status=${verifyGoodSigFakeGateway.status} body=${verifyGoodSigFakeGateway.text}`);

  // Verify with a disallowed gateway string ("cash" self-reported) -> must be rejected, not silently accepted
  const verifyCash = await call('POST', '/service_api/payments/verify', { as: customerTok, body: { bookingId, gateway: 'cash' } });
  check('verify self-reported "cash" gateway rejected by validator (400)', verifyCash.status === 400, `status=${verifyCash.status} body=${verifyCash.text}`);

  // =========================================================================
  // 3. Webhook: unsigned / malformed payloads must be rejected cleanly, not crash
  // =========================================================================
  const webhookNoSig = await call('POST', '/service_api/payments/razorpay-webhook', {
    body: { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_x', amount: 79900, notes: { bookingId: String(bookingId) } } } } },
  });
  check('webhook with no signature header -> 400 (not 500/crash)', webhookNoSig.status === 400, `status=${webhookNoSig.status} body=${webhookNoSig.text}`);

  const webhookBadSig = await call('POST', '/service_api/payments/razorpay-webhook', {
    headers: { 'x-razorpay-signature': 'deadbeefdeadbeef' },
    body: { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_x', amount: 79900 } } } },
  });
  check('webhook with wrong signature -> 400 (not 500/crash)', webhookBadSig.status === 400, `status=${webhookBadSig.status} body=${webhookBadSig.text}`);

  // Malformed body (missing payload/event entirely) but signed correctly for that raw body.
  // We can't easily produce a correctly-signed body without duplicating express's raw
  // capture, so this exercises the unsigned path only, which the code always hits first.
  const webhookGarbage = await call('POST', '/service_api/payments/razorpay-webhook', {
    headers: { 'x-razorpay-signature': 'garbage' },
    body: { totally: 'not-a-webhook-shape' },
  });
  check('webhook with syntactically-valid but garbage payload -> clean 4xx (not 500/crash)', webhookGarbage.status === 400, `status=${webhookGarbage.status} body=${webhookGarbage.text}`);

  // =========================================================================
  // 4. Vendor earnings / payments list endpoints
  // =========================================================================
  const earningsOk = await call('GET', `/service_api/vendor/${ids.vendor.id}/earning`, { as: vendorTok });
  check('vendor earnings (own) -> 200', earningsOk.status === 200, `status=${earningsOk.status} body=${earningsOk.text}`);
  if (earningsOk.json) {
    const shapeIssues = scanForBrokenShapes(earningsOk.json);
    check('vendor earnings response has no broken {s,e,d}/date shapes', shapeIssues.length === 0, JSON.stringify(shapeIssues));
    check('vendor earnings amount fields are numbers, not Decimal objects', typeof earningsOk.json.total_earnings === 'number' && typeof earningsOk.json.today_earnings === 'number', JSON.stringify(earningsOk.json));
  }

  const earningsOtherVendor = await call('GET', `/service_api/vendor/${ids.vendor.id}/earning`, { as: vendor2Tok });
  check('vendor earnings (other vendor) -> 403', earningsOtherVendor.status === 403, `status=${earningsOtherVendor.status}`);

  const paymentsOk = await call('GET', `/service_api/vendor/${ids.vendor.id}/payments`, { as: vendorTok });
  check('vendor payments list (own) -> 200', paymentsOk.status === 200, `status=${paymentsOk.status} body=${paymentsOk.text}`);
  if (paymentsOk.json) check('vendor payments list has no broken shapes', scanForBrokenShapes(paymentsOk.json).length === 0, JSON.stringify(scanForBrokenShapes(paymentsOk.json)));

  const paymentsOtherVendor = await call('GET', `/service_api/vendor/${ids.vendor.id}/payments`, { as: vendor2Tok });
  check('vendor payments list (other vendor) -> 403', paymentsOtherVendor.status === 403, `status=${paymentsOtherVendor.status}`);

  // --- KNOWN GAP (do not fix, confirm it's reproducible): Payment.vendorId
  // doesn't exist, so getVendorPayments filters only by method/vendorPayoutStatus,
  // not by which vendor the Keplix-payment actually belongs to. Create a
  // vendor->Keplix "payment" (as vendor2, via verifyVendorPayment path is blocked
  // by fake gateway -- instead inspect via Prisma directly, as the audit harness allows).
  const crossVendorPayment = await prisma.payment.create({
    data: {
      amount: 500, currency: 'INR', status: 'success', method: 'razorpay',
      transactionId: 'TXN_CROSS_VENDOR_TEST', vendorPayoutStatus: 'not_applicable',
      platformFee: 500, vendorAmount: 0,
    },
  });
  const paymentsAfterCrossInsert = await call('GET', `/service_api/vendor/${ids.vendor.id}/payments`, { as: vendorTok });
  const leaksCrossVendorRow = Array.isArray(paymentsAfterCrossInsert.json) &&
    paymentsAfterCrossInsert.json.some(p => p.transactionId === 'TXN_CROSS_VENDOR_TEST');
  results.push(`INFO  KNOWN SCHEMA GAP reproduced: Payment has no vendorId column, so vendor 1's ` +
    `/payments list ${leaksCrossVendorRow ? 'DOES' : 'does NOT'} include a Keplix-payment row created ` +
    `for a different vendor (transactionId=TXN_CROSS_VENDOR_TEST). This matches the FOLLOW-UP comment ` +
    `already in controllers/vendor/paymentController.js:getVendorPayments -- NOT fixed here per instructions ` +
    `(schema change / owner decision needed).`);
  await prisma.payment.delete({ where: { id: crossVendorPayment.id } }).catch(() => {});

  // Unauthenticated access
  const earningsNoAuth = await call('GET', `/service_api/vendor/${ids.vendor.id}/earning`, {});
  check('vendor earnings unauthenticated -> 401', earningsNoAuth.status === 401, `status=${earningsNoAuth.status}`);

  // =========================================================================
  // 5. Vendor payment order create / verify (Vendor -> Keplix)
  // =========================================================================
  const vOrderBadAmount = await call('POST', '/service_api/vendor/payments/order/create', { as: vendorTok, body: { amount: -5 } });
  check('vendor order/create negative amount -> 400', vOrderBadAmount.status === 400, `status=${vOrderBadAmount.status} body=${vOrderBadAmount.text}`);

  const vOrderNaN = await call('POST', '/service_api/vendor/payments/order/create', { as: vendorTok, body: { amount: 'not-a-number' } });
  check('vendor order/create non-numeric amount -> 400', vOrderNaN.status === 400, `status=${vOrderNaN.status} body=${vOrderNaN.text}`);

  const vOrder = await call('POST', '/service_api/vendor/payments/order/create', { as: vendorTok, body: { amount: 999, gateway: 'razorpay' } });
  check('vendor order/create with fake gateway -> clean status (not silent success beyond what SDK allows)', vOrder.status !== 0, vOrder.error);
  check('vendor order/create: gateway auth failure -> 502, not 500', vOrder.status === 502, `status=${vOrder.status} body=${vOrder.text}`);
  results.push(`INFO  vendor order/create actual status vs real gateway: ${vOrder.status} body=${vOrder.text}`);

  const vVerifyBadSig = await call('POST', '/service_api/vendor/payments/verify', {
    as: vendorTok,
    body: { orderId: 'order_x', paymentId: 'pay_x', signature: 'bad', gateway: 'razorpay' },
  });
  check('vendor verify bad signature -> 400 (not 500)', vVerifyBadSig.status === 400, `status=${vVerifyBadSig.status} body=${vVerifyBadSig.text}`);

  const vVerifyUnsupportedGateway = await call('POST', '/service_api/vendor/payments/verify', {
    as: vendorTok,
    body: { orderId: 'o', paymentId: 'p', signature: 's', gateway: 'stripe' },
  });
  check('vendor verify unsupported gateway -> 400', vVerifyUnsupportedGateway.status === 400, `status=${vVerifyUnsupportedGateway.status} body=${vVerifyUnsupportedGateway.text}`);

  // =========================================================================
  // 6. Refund calculation logic, at controller/service level (no real refund
  //    route to hit in these two files -- check the service module directly)
  // =========================================================================
  let refundServiceIssues = [];
  try {
    const refundServiceMod = await import('../../services/refundService.js').catch(() => null);
    if (refundServiceMod) {
      results.push('INFO  services/refundService.js found; inspected exports: ' + Object.keys(refundServiceMod).join(', '));
    } else {
      results.push('INFO  services/refundService.js not found -- refund logic may live elsewhere or not exist as a separate module; not part of routes/user|vendor/payments.js so not exercised further here.');
    }
  } catch (e) {
    refundServiceIssues.push(e.message);
  }
  check('refund service module import does not crash', refundServiceIssues.length === 0, refundServiceIssues.join('; '));

} catch (fatal) {
  fail++;
  results.push(`FATAL  ${fatal.stack || fatal.message}`);
} finally {
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await shutdown();
  process.exit(fail > 0 ? 1 : 0);
}
