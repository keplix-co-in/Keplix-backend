/**
 * Pricing v2 extras: job photos, parts-used note, customer contact, bill link
 * (services/pricingV2Service.js), the vendor photo/parts controllers, the
 * public bill page and the earnings controller. Prisma is a small in-memory fake.
 */
import { jest } from '@jest/globals';

let db;
let nextId;
const newId = () => ++nextId;

const assemble = () => {
  const b = db.booking;
  if (!b) return null;
  return {
    ...b,
    service: { id: 3, name: 'Brake service', vendorId: b.vendorId, vendor: { vendorProfile: { business_name: 'Raj Motors' } } },
    user: { userProfile: { name: 'Rahul', phone: '+919999900000' } },
    payment: db.payment,
    bookingQuote: db.quote ? { ...db.quote, lines: [] } : null,
    bookingJob: db.job,
    extraWorkRequests: db.requests.map((r) => ({ ...r, items: [] })),
    finalBills: db.bills.filter((x) => ['issued', 'paid'].includes(x.status)).map((x) => ({ ...x, lines: [] })),
    bookingPhotos: db.photos.map((p) => ({ ...p })),
    bookingEvents: db.events.filter((e) => e.type === 'parts_used').map((e) => ({ ...e })),
  };
};

const fake = {
  $executeRaw: jest.fn(async () => 1),
  booking: { findUnique: jest.fn(async ({ where }) => (db.booking?.id === where.id ? assemble() : null)) },
  bookingPhoto: {
    createMany: jest.fn(async ({ data }) => {
      for (const d of data) db.photos.push({ id: newId(), createdAt: new Date(), ...d });
      return { count: data.length };
    }),
  },
  bookingEvent: {
    create: jest.fn(async ({ data }) => {
      db.events.push({ id: newId(), created_at: new Date(), ...data });
      return data;
    }),
  },
  finalBill: { findUnique: jest.fn(async ({ where }) => db.bills.find((b) => b.id === where.id) ?? null) },
  payment: { findMany: jest.fn(async () => db.paymentsForVendor ?? []) },
  $transaction: jest.fn(async (fn) => fn(fake)),
};

const emit = jest.fn();
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: fake }));
jest.unstable_mockModule('../../socket.js', () => ({ getIO: () => ({ to: () => ({ emit }) }) }));
jest.unstable_mockModule('../../queues/notificationQueue.js', () => ({ addNotificationJob: jest.fn(async () => ({})), default: jest.fn() }));

const svc = await import('../../services/pricingV2Service.js');
const vendorCtl = await import('../../controllers/vendor/pricingController.js');
const billCtl = await import('../../controllers/public/billController.js');
const earningsCtl = await import('../../controllers/vendor/earningsController.js');
const { verifyBillToken, signBillToken } = await import('../../util/billToken.js');

const USER = 11;
const VENDOR = 22;
const BOOKING = 100;
const vctx = { bookingId: BOOKING, actorId: VENDOR };

const seed = (over = {}) => {
  nextId = 1000;
  db = {
    booking: { id: BOOKING, userId: USER, vendorId: VENDOR, status: 'in_progress', vendor_status: 'accepted', ...over },
    payment: null,
    quote: { id: 1, tax_inclusive: true },
    job: { id: 1, checked_in_at: new Date() },
    requests: [{ id: 50, number: 1, status: 'pending', createdAt: new Date(), items: [] }],
    bills: [],
    photos: [],
    events: [],
  };
};

const expectError = (p, status, code) => expect(p).rejects.toMatchObject({ status, code });

beforeEach(() => {
  process.env.BILL_LINK_SECRET = 'a-test-secret-that-is-at-least-32-chars-long';
  jest.clearAllMocks();
  seed();
});

describe('job photos', () => {
  test('check-in photos are stored, audited, and returned in job.photos for both roles', async () => {
    const { status, body } = await svc.addPhotos(vctx, { kind: 'check_in', urls: ['https://c/1.jpg', 'https://c/2.jpg'] });
    expect(status).toBe(201);
    expect(db.photos).toHaveLength(2);
    expect(db.photos[0]).toMatchObject({ bookingId: BOOKING, kind: 'check_in', extraWorkRequestId: null, created_by: VENDOR });
    expect(body.job.photos.map((p) => p.url)).toEqual(['https://c/1.jpg', 'https://c/2.jpg']);
    expect(db.events).toEqual([expect.objectContaining({ type: 'photos_added', payload: { kind: 'check_in', requestId: null, count: 2 } })]);
    expect(emit).toHaveBeenCalledWith('booking:pricing_updated', { bookingId: BOOKING });
    const customer = await svc.getPricing({ bookingId: BOOKING, role: 'user', actorId: USER });
    expect(customer.job.photos).toHaveLength(2);
  });

  test('extra-work photos attach to the request and show on the customer approval screen', async () => {
    await svc.addPhotos(vctx, { kind: 'extra_work', requestId: 50, urls: ['https://c/x.jpg'] });
    expect(db.photos[0]).toMatchObject({ kind: 'extra_work', extraWorkRequestId: 50 });
    const customer = await svc.getPricing({ bookingId: BOOKING, role: 'user', actorId: USER });
    expect(customer.requests[0].photos.map((p) => p.url)).toEqual(['https://c/x.jpg']);
    expect(customer.job.photos).toEqual([]);
  });

  test('guards: not checked in, unknown/closed request, open bill, limits, other vendor', async () => {
    db.job = null;
    await expectError(svc.addPhotos(vctx, { kind: 'check_in', urls: ['u'] }), 409, 'NOT_CHECKED_IN');
    seed();
    await expectError(svc.addPhotos(vctx, { kind: 'extra_work', requestId: 999, urls: ['u'] }), 404, 'NOT_FOUND');
    db.requests[0].status = 'approved';
    await expectError(svc.addPhotos(vctx, { kind: 'extra_work', requestId: 50, urls: ['u'] }), 409, 'REQUEST_CLOSED');
    seed();
    await expectError(svc.addPhotos(vctx, { kind: 'check_in', urls: Array(11).fill('u') }), 409, 'PHOTO_LIMIT');
    db.bills = [{ id: 1, status: 'issued' }];
    await expectError(svc.addPhotos(vctx, { kind: 'extra_work', requestId: 50, urls: ['u'] }), 409, 'BILL_EXISTS');
    await expectError(svc.addPhotos({ bookingId: BOOKING, actorId: 999 }, { kind: 'check_in', urls: ['u'] }), 403, 'FORBIDDEN');
    expect(db.photos).toHaveLength(0);
  });

  test('legacy booking -> 409 NOT_V2', async () => {
    db.quote = null;
    await expectError(svc.addPhotos(vctx, { kind: 'check_in', urls: ['u'] }), 409, 'NOT_V2');
  });
});

describe('vendorAddPhotos controller validation', () => {
  const call = async (req) => {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    await vendorCtl.vendorAddPhotos({ params: { id: String(BOOKING) }, user: { id: VENDOR }, ...req }, res);
    return res;
  };
  const img = (url) => ({ cloudinary: { resource_type: 'image', secure_url: url } });

  test('bad kind, missing request_id, no files, non-image -> 400 VALIDATION_ERROR', async () => {
    for (const req of [
      { body: { kind: 'x' }, files: { photos: [img('a')] } },
      { body: { kind: 'extra_work' }, files: { photos: [img('a')] } },
      { body: { kind: 'check_in' }, files: {} },
      { body: { kind: 'check_in' }, files: { photos: [{ cloudinary: { resource_type: 'raw', secure_url: 'a.pdf' } }] } },
    ]) {
      const res = await call(req);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    }
    expect(db.photos).toHaveLength(0);
  });

  test('valid upload stores the Cloudinary secure_url and returns 201 with the pricing view', async () => {
    const res = await call({ body: { kind: 'check_in' }, files: { photos: [img('https://c/a.jpg')] } });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].job.photos[0].url).toBe('https://c/a.jpg');
  });
});

describe('parts used', () => {
  test('records a parts_used event and exposes it in job.parts_used', async () => {
    const { status, body } = await svc.recordPartsUsed(vctx, '  2 brake pads, 1 fluid  ');
    expect(status).toBe(201);
    expect(db.events[0]).toMatchObject({ type: 'parts_used', actor_role: 'vendor', payload: { note: '2 brake pads, 1 fluid' } });
    expect(body.job.parts_used).toEqual([{ note: '2 brake pads, 1 fluid', at: expect.any(String) }]);
  });

  test('guards: not checked in, note cap, wrong vendor', async () => {
    db.job = null;
    await expectError(svc.recordPartsUsed(vctx, 'x'), 409, 'NOT_CHECKED_IN');
    seed();
    for (let i = 0; i < svc.MAX_PARTS_USED_NOTES; i++) await svc.recordPartsUsed(vctx, `n${i}`);
    await expectError(svc.recordPartsUsed(vctx, 'one more'), 409, 'NOTE_LIMIT');
    await expectError(svc.recordPartsUsed({ bookingId: BOOKING, actorId: 5 }, 'x'), 403, 'FORBIDDEN');
  });
});

describe('customer contact', () => {
  test('own accepted v2 booking returns name and phone only', async () => {
    expect(await svc.getCustomerContact(vctx)).toEqual({ booking_id: BOOKING, name: 'Rahul', phone: '+919999900000' });
  });

  test('other vendor 403, unknown 404, legacy 409, not accepted / cancelled 409', async () => {
    await expectError(svc.getCustomerContact({ bookingId: BOOKING, actorId: 5 }), 403, 'FORBIDDEN');
    await expectError(svc.getCustomerContact({ bookingId: 5, actorId: VENDOR }), 404, 'NOT_FOUND');
    db.booking.vendor_status = 'pending';
    await expectError(svc.getCustomerContact(vctx), 409, 'INVALID_STATE');
    seed({ status: 'cancelled' });
    await expectError(svc.getCustomerContact(vctx), 409, 'INVALID_STATE');
    seed();
    db.quote = null;
    await expectError(svc.getCustomerContact(vctx), 409, 'NOT_V2');
  });
});

describe('bill link + public bill page', () => {
  const issued = () => ({
    id: 7, bookingId: BOOKING, number: 'KPX-2026-000001', status: 'issued', issued_at: new Date(), paid_at: null,
    labour_total: 100, parts_total: 0, total: 100,
    lines: [{ name: 'Labour', qty: 1, unit_price: 100, line_total: 100 }],
  });
  const withBooking = (b) => ({
    ...b,
    booking: {
      id: BOOKING, userId: USER,
      service: { name: 'Brake service', vendorId: VENDOR, vendor: { vendorProfile: { business_name: 'Raj Motors' } } },
      user: { userProfile: { name: 'Rahul' } },
      payment: { status: 'success', platformFee: '5.00', feeModel: 'on_top' },
      bookingQuote: { tax_inclusive: true },
    },
  });

  test('either party can mint a link once a bill exists; none before', async () => {
    await expectError(svc.createBillLink({ ...vctx, role: 'vendor' }), 409, 'BILL_NOT_ISSUED');
    db.bills = [issued()];
    const v = await svc.createBillLink({ ...vctx, role: 'vendor' });
    const u = await svc.createBillLink({ bookingId: BOOKING, role: 'user', actorId: USER });
    expect(verifyBillToken(v.token)).toEqual({ billId: 7, role: 'vendor', actorId: VENDOR });
    expect(verifyBillToken(u.token)).toEqual({ billId: 7, role: 'user', actorId: USER });
    await expectError(svc.createBillLink({ bookingId: BOOKING, role: 'user', actorId: 999 }), 403, 'FORBIDDEN');
  });

  test('BILL_LINK_SECRET missing -> 503 BILL_LINK_UNAVAILABLE', async () => {
    db.bills = [issued()];
    delete process.env.BILL_LINK_SECRET;
    await expectError(svc.createBillLink({ ...vctx, role: 'vendor' }), 503, 'BILL_LINK_UNAVAILABLE');
  });

  const view = async (id, t) => {
    const res = { headers: {}, set: jest.fn((k, v) => { res.headers[k] = v; return res; }), status: jest.fn(() => res), type: jest.fn(() => res), send: jest.fn(() => res) };
    await billCtl.viewBill({ params: { id }, query: { t } }, res);
    return res;
  };

  test('valid token renders the Final bill with no-store, CSP nonce, and the customer-only fee', async () => {
    db.bills = [issued()];
    fake.finalBill.findUnique.mockImplementationOnce(async () => withBooking(db.bills[0]));
    const { token } = signBillToken({ billId: 7, role: 'user', actorId: USER });
    const res = await view('7', token);
    expect(res.status).toHaveBeenCalledWith(200);
    const html = res.send.mock.calls[0][0];
    expect(html).toContain('Final bill');
    expect(html).toContain('KPX-2026-000001');
    expect(html).toContain('Keplix platform fee');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Content-Security-Policy']).toMatch(/script-src 'nonce-[^']+'/);
  });

  test('vendor copy has no platform fee line', async () => {
    fake.finalBill.findUnique.mockImplementationOnce(async () => withBooking(issued()));
    const { token } = signBillToken({ billId: 7, role: 'vendor', actorId: VENDOR });
    const res = await view('7', token);
    expect(res.send.mock.calls[0][0]).not.toContain('platform fee');
  });

  test('bad / expired / other-bill token -> 403; wrong owner or void -> 404; no DB hit on a bad token', async () => {
    const good = signBillToken({ billId: 7, role: 'user', actorId: USER });
    expect((await view('7', 'junk')).status).toHaveBeenCalledWith(403);
    expect((await view('8', good.token)).status).toHaveBeenCalledWith(403);
    expect((await view('7', undefined)).status).toHaveBeenCalledWith(403);
    const expired = signBillToken({ billId: 7, role: 'user', actorId: USER }, Date.now() - 16 * 60 * 1000);
    expect((await view('7', expired.token)).status).toHaveBeenCalledWith(403);
    expect(fake.finalBill.findUnique).not.toHaveBeenCalled();

    fake.finalBill.findUnique.mockImplementationOnce(async () => withBooking(issued()));
    const stranger = signBillToken({ billId: 7, role: 'user', actorId: 999 });
    expect((await view('7', stranger.token)).status).toHaveBeenCalledWith(404);
    fake.finalBill.findUnique.mockImplementationOnce(async () => withBooking({ ...issued(), status: 'void' }));
    expect((await view('7', good.token)).status).toHaveBeenCalledWith(404);
  });
});

describe('earnings controller', () => {
  const mkRes = () => { const res = { status: jest.fn(() => res), json: jest.fn(() => res) }; return res; };

  test('per-booking earnings for the owner; 403 for another vendor; 400 bad id', async () => {
    db.payment = { amount: '1050', status: 'success', platformFee: '50', vendorAmount: '1000', vendorPayoutStatus: 'pending', payoutHoldUntil: null };
    db.bills = [{ id: 7, status: 'paid', number: 'KPX-1', total: '1000.00' }];
    fake.booking.findUnique.mockImplementationOnce(async () => ({ id: BOOKING, status: 'in_progress', service: { vendorId: VENDOR }, payment: db.payment, finalBills: db.bills }));
    const res = mkRes();
    await earningsCtl.getBookingEarnings({ params: { id: '100' }, user: { id: VENDOR } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({ booking_id: 100, bill_total: 1000, customer_paid: 1050, platform_fee: 50, payout_amount: 1000, payout_status: 'after_completion' });

    fake.booking.findUnique.mockImplementationOnce(async () => ({ id: BOOKING, status: 'in_progress', service: { vendorId: VENDOR }, payment: null, finalBills: [] }));
    const res2 = mkRes();
    await earningsCtl.getBookingEarnings({ params: { id: '100' }, user: { id: 999 } }, res2);
    expect(res2.status).toHaveBeenCalledWith(403);

    const res3 = mkRes();
    await earningsCtl.getBookingEarnings({ params: { id: 'abc' }, user: { id: VENDOR } }, res3);
    expect(res3.status).toHaveBeenCalledWith(400);
  });

  test('summary scopes the query to the vendor and totals the rows; bad dates -> 400', async () => {
    db.paymentsForVendor = [
      { amount: '1050', status: 'success', platformFee: '50', vendorAmount: '1000', vendorPayoutStatus: 'paid', payoutHoldUntil: null, booking: { status: 'completed' } },
      { amount: '500', status: 'success', platformFee: '0', vendorAmount: '500', vendorPayoutStatus: 'pending', payoutHoldUntil: null, booking: { status: 'in_progress' } },
    ];
    const res = mkRes();
    await earningsCtl.getEarningsSummary({ query: { from: '2026-11-01' }, user: { id: VENDOR } }, res);
    const where = fake.payment.findMany.mock.calls[0][0].where;
    expect(where.booking.service.vendorId).toBe(VENDOR);
    expect(res.json.mock.calls[0][0]).toMatchObject({ customer_paid_total: 1550, platform_fee_total: 50, payout_paid_total: 1000, payout_pending_total: 500, booking_count: 2, truncated: false });

    const bad = mkRes();
    await earningsCtl.getEarningsSummary({ query: { from: 'nope' }, user: { id: VENDOR } }, bad);
    expect(bad.status).toHaveBeenCalledWith(400);
  });
});
