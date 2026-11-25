/**
 * Pricing v2 on vendor service create/update (docs/PRICING_V2_API.md section 1):
 * validation of both payload kinds (multipart strings and JSON), the
 * server-computed price, the legacy fallback, and which path an update takes.
 */
import { jest } from '@jest/globals';

const tx = {
  service: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  servicePriceLine: { deleteMany: jest.fn(), createMany: jest.fn() },
  serviceSegmentPrice: { deleteMany: jest.fn(), createMany: jest.fn() },
};
const mockPrisma = {
  service: { findUnique: jest.fn(), findMany: jest.fn(), delete: jest.fn() },
  $transaction: jest.fn(async (fn) => fn(tx)),
};
jest.unstable_mockModule('../../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../util/cloudinary.js', () => ({ acceptOwnCloudinaryUrl: (u) => u ?? null }));

const { createServiceSchema, updateServiceSchema } = await import('../../../validators/vendor/serviceValidators.js');
const { createService, updateService, planServiceUpdate } = await import('../../../controllers/vendor/serviceController.js');

const VENDOR = 7;
const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
const base = { name: 'Brake service', description: 'Pads and fluid', duration: '60', category: 'Brakes' };

beforeEach(() => {
  jest.clearAllMocks();
  tx.service.create.mockResolvedValue({ id: 50 });
  tx.service.update.mockResolvedValue({ id: 50 });
  tx.service.findUnique.mockImplementation(async () => ({ id: 50, price: 0, priceLines: [], segmentPrices: [] }));
});

describe('createServiceSchema', () => {
  it('allows an empty or missing description (owner 2026-11-21)', () => {
    const { description: _d, ...noDesc } = base;
    expect(createServiceSchema.parse({ ...noDesc, price: '500' }).description).toBe('');
    expect(createServiceSchema.parse({ ...base, description: '   ', price: '500' }).description).toBe('');
    expect(updateServiceSchema.parse({ description: '' }).description).toBe('');
  });

  test('legacy multipart payload (all strings) still validates', () => {
    const out = createServiceSchema.parse({ ...base, price: '1200', segment_prices: '[{"segment":"SEDAN","price":1500}]' });
    expect(out.price).toBe(1200);
    expect(out.segment_prices).toEqual([{ segment: 'SEDAN', price: 1500 }]);
  });

  test('v2 multipart payload: JSON-string lines, "true" tax flag, string fee', () => {
    const out = createServiceSchema.parse({
      ...base,
      price: '0',
      pricing_type: 'starting',
      price_lines: JSON.stringify([{ kind: 'labour', name: 'Labour', qty: 1, unit_price: 1000 }]),
      inclusions: '["Labour"]',
      tax_inclusive: 'false',
    });
    expect(out.price_lines).toHaveLength(1);
    expect(out.tax_inclusive).toBe(false);
  });

  test('v2 JSON payload: real arrays, boolean and number', () => {
    const out = createServiceSchema.parse({
      ...base,
      pricing_type: 'inspection',
      price_lines: [],
      inspection_fee: 299,
      tax_inclusive: true,
    });
    expect(out.inspection_fee).toBe(299);
    expect(out.price_lines).toEqual([]);
  });

  test('legacy payload: price is required and must be > 0', () => {
    expect(createServiceSchema.safeParse({ ...base }).success).toBe(false);
    expect(createServiceSchema.safeParse({ ...base, price: '0' }).success).toBe(false);
  });

  test("type rules: 'starting' needs an inclusion, 'inspection' needs a fee", () => {
    const lines = [{ kind: 'labour', name: 'L', qty: 1, unit_price: 100 }];
    expect(createServiceSchema.safeParse({ ...base, pricing_type: 'starting', price_lines: lines }).success).toBe(false);
    expect(createServiceSchema.safeParse({ ...base, pricing_type: 'inspection', price_lines: [] }).success).toBe(false);
    expect(createServiceSchema.safeParse({ ...base, pricing_type: 'starting', price: '500' , inclusions: ['x'] }).success).toBe(false);
  });

  test('line limits: 2-decimal money, positive qty', () => {
    const bad = [{ kind: 'labour', name: 'L', qty: 0, unit_price: 100 }];
    expect(createServiceSchema.safeParse({ ...base, price_lines: bad }).success).toBe(false);
    const cents = [{ kind: 'labour', name: 'L', qty: 1, unit_price: 10.555 }];
    expect(createServiceSchema.safeParse({ ...base, price_lines: cents }).success).toBe(false);
  });

  test('update schema: a pause toggle alone is valid', () => {
    expect(updateServiceSchema.parse({ is_active: 'false' })).toEqual({ is_active: false });
  });
});

describe('createService', () => {
  const req = (body) => ({ user: { id: VENDOR, role: 'vendor' }, body });

  test('v2: price is computed from the lines; the client price is ignored', async () => {
    const res = makeRes();
    await createService(
      req({
        ...base,
        price: 1, // ignored
        pricing_type: 'fixed',
        price_lines: [
          { segment: null, kind: 'labour', name: 'Labour', qty: 1, unit_price: 5000 },
          { segment: null, kind: 'part', name: 'Pads', qty: 1, unit_price: 2800 },
        ],
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(tx.service.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ price: 7800, pricing_type: 'fixed', breakdown_confirmed: true }),
    });
    expect(tx.servicePriceLine.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ serviceId: 50, kind: 'labour', unit_price: 5000, sort_order: 0 }),
        expect.objectContaining({ serviceId: 50, kind: 'part', unit_price: 2800, sort_order: 1 }),
      ],
    });
  });

  test('legacy: stores the price as sent plus synthesised lines, breakdown not confirmed', async () => {
    const res = makeRes();
    await createService(req({ ...base, price: 1200, segment_prices: [{ segment: 'SEDAN', price: 1500 }] }), res);
    expect(tx.service.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ price: 1200, pricing_type: 'fixed', breakdown_confirmed: false }),
    });
    expect(tx.servicePriceLine.createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(tx.serviceSegmentPrice.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ serviceId: 50, segment: 'SEDAN', price: 1500 })],
    });
  });

  test('the response always carries the v2 fields', async () => {
    const res = makeRes();
    await createService(req({ ...base, price: 1200 }), res);
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual(expect.objectContaining({ pricing_type: 'fixed', price_lines: expect.any(Array), breakdown_confirmed: false }));
    expect(body).not.toHaveProperty('priceLines');
  });
});

describe('planServiceUpdate / updateService', () => {
  const existing = {
    id: 50,
    vendorId: VENDOR,
    price: 1000,
    pricing_type: 'fixed',
    breakdown_confirmed: true,
    inclusions: [],
    priceLines: [{ id: 1, segment: null, kind: 'labour', name: 'Labour', qty: 1, unit_price: 1000, sort_order: 0 }],
    segmentPrices: [{ segment: 'SEDAN', price: 1200 }],
  };

  test('no pricing field (e.g. {is_active}) -> null: lines and segment prices untouched', () => {
    expect(planServiceUpdate({ is_active: false }, existing)).toBeNull();
    expect(planServiceUpdate({ inclusions: ['x'], price_change_note: 'n' }, existing)).toBeNull();
  });

  test('price without lines -> legacy path; segment rows kept when not sent', () => {
    const plan = planServiceUpdate({ price: 1500 }, existing);
    expect(plan).toMatchObject({ pricingType: 'fixed', price: 1500, breakdownConfirmed: false, segmentPrices: null });
    expect(plan.lines.map((l) => l.unit_price)).toEqual([1500, 1200]);
  });

  test('pricing_type only -> stored lines kept (lines: null), totals recomputed', () => {
    const plan = planServiceUpdate({ pricing_type: 'inspection', inspection_fee: 299 }, existing);
    expect(plan.lines).toBeNull();
    expect(plan.pricingType).toBe('inspection');
    expect(plan.breakdownConfirmed).toBe(true);
  });

  test('inspection with price_lines: [] deletes the lines AND the segment price rows', async () => {
    mockPrisma.service.findUnique.mockResolvedValue(existing);
    const res = makeRes();
    await updateService(
      { user: { id: VENDOR }, params: { id: '50' }, body: { pricing_type: 'inspection', inspection_fee: 299, price_lines: [] } },
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(tx.servicePriceLine.deleteMany).toHaveBeenCalledWith({ where: { serviceId: 50 } });
    expect(tx.serviceSegmentPrice.deleteMany).toHaveBeenCalledWith({ where: { serviceId: 50 } });
    expect(tx.servicePriceLine.createMany).not.toHaveBeenCalled();
    expect(tx.service.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: expect.objectContaining({ price: 299, pricing_type: 'inspection' }),
    });
  });

  test('a pause toggle never touches pricing rows', async () => {
    mockPrisma.service.findUnique.mockResolvedValue(existing);
    const res = makeRes();
    await updateService({ user: { id: VENDOR }, params: { id: '50' }, body: { is_active: false } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(tx.servicePriceLine.deleteMany).not.toHaveBeenCalled();
    expect(tx.serviceSegmentPrice.deleteMany).not.toHaveBeenCalled();
    expect(tx.service.update.mock.calls[0][0].data).not.toHaveProperty('price');
  });

  test("switching to 'starting' without an inclusion is a 400 on the merged state", async () => {
    mockPrisma.service.findUnique.mockResolvedValue(existing);
    const res = makeRes();
    await updateService({ user: { id: VENDOR }, params: { id: '50' }, body: { pricing_type: 'starting' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  test("another vendor's service -> 403", async () => {
    mockPrisma.service.findUnique.mockResolvedValue({ ...existing, vendorId: 999 });
    const res = makeRes();
    await updateService({ user: { id: VENDOR }, params: { id: '50' }, body: { price: 10 } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
