/**
 * Pricing v2 shape helpers (util/pricingV2.js): service read/write planning,
 * the booking quote snapshot, and the role-specific `can` flags.
 */
import {
  serializeServicePricing,
  withServicePricing,
  planServicePricingWrite,
  buildQuoteSnapshot,
  computeCan,
  buildPricingView,
  withPricingFlow,
  billOut,
  LEGACY_LINE_NAME,
  INSPECTION_LINE_NAME,
} from '../../util/pricingV2.js';

describe('service read shape', () => {
  test('a legacy service (no stored lines) is synthesised and not breakdown-confirmed', () => {
    const out = serializeServicePricing({
      price: 1200,
      pricing_type: 'fixed',
      breakdown_confirmed: true,
      segmentPrices: [{ segment: 'SEDAN', price: 1500 }],
      priceLines: [],
    });
    expect(out.pricing_type).toBe('fixed');
    expect(out.breakdown_confirmed).toBe(false);
    expect(out.price_lines).toEqual([
      expect.objectContaining({ segment: null, kind: 'labour', name: LEGACY_LINE_NAME, unit_price: 1200, line_total: 1200 }),
      expect.objectContaining({ segment: 'SEDAN', name: LEGACY_LINE_NAME, unit_price: 1500 }),
    ]);
    expect(out.labour_total).toBe(1200);
    expect(out.parts_total).toBe(0);
    expect(out.tax_inclusive).toBe(true);
  });

  test('stored lines are returned sorted, with totals from the base lines only', () => {
    const out = serializeServicePricing({
      price: 1800,
      pricing_type: 'starting',
      breakdown_confirmed: true,
      inclusions: ['Labour'],
      priceLines: [
        { id: 2, segment: null, kind: 'part', name: 'Oil', qty: 1, unit_price: 800, sort_order: 1 },
        { id: 1, segment: null, kind: 'labour', name: 'Service', qty: 1, unit_price: 1000, sort_order: 0 },
        { id: 3, segment: 'LUXURY', kind: 'labour', name: 'Service', qty: 1, unit_price: 3000, sort_order: 2 },
      ],
    });
    expect(out.price_lines.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(out.labour_total).toBe(1000);
    expect(out.parts_total).toBe(800);
    expect(out.breakdown_confirmed).toBe(true);
    expect(out.inclusions).toEqual(['Labour']);
  });

  test('withServicePricing drops the raw priceLines relation', () => {
    const out = withServicePricing({ id: 1, price: 500, priceLines: [], segmentPrices: [] });
    expect(out).not.toHaveProperty('priceLines');
    expect(out.price_lines).toHaveLength(1);
  });

  test('an inspection service shows the fee as its labour total', () => {
    const out = serializeServicePricing({ pricing_type: 'inspection', inspection_fee: 299, price: 299, priceLines: [] });
    expect(out.price_lines).toEqual([]);
    expect(out.labour_total).toBe(299);
  });
});

describe('planServicePricingWrite', () => {
  test('v2: price and segment prices are derived from the lines (client price ignored)', () => {
    const plan = planServicePricingWrite({
      pricing_type: 'fixed',
      price: 1, // ignored
      price_lines: [
        { segment: null, kind: 'labour', name: 'Labour', qty: 1, unit_price: 5000 },
        { segment: null, kind: 'part', name: 'Pads', qty: 2, unit_price: 1400 },
        { segment: 'SEDAN', kind: 'labour', name: 'Labour', qty: 1, unit_price: 6000 },
      ],
    });
    expect(plan.price).toBe(7800);
    expect(plan.segmentPrices).toEqual([{ segment: 'SEDAN', price: 6000 }]);
    expect(plan.breakdownConfirmed).toBe(true);
    expect(plan.lines.map((l) => l.sort_order)).toEqual([0, 1, 2]);
  });

  test('legacy payload stores a synthesised line per price', () => {
    const plan = planServicePricingWrite({ price: 900, segment_prices: [{ segment: 'MUV', price: 1100 }] });
    expect(plan.pricingType).toBe('fixed');
    expect(plan.price).toBe(900);
    expect(plan.breakdownConfirmed).toBe(false);
    expect(plan.lines).toEqual([
      expect.objectContaining({ segment: null, name: LEGACY_LINE_NAME, unit_price: 900 }),
      expect.objectContaining({ segment: 'MUV', unit_price: 1100 }),
    ]);
    expect(plan.segmentPrices).toEqual([{ segment: 'MUV', price: 1100 }]);
  });

  test('inspection with price_lines: [] -> price = fee, no lines, no segment prices', () => {
    const plan = planServicePricingWrite({ pricing_type: 'inspection', inspection_fee: 299, price_lines: [] });
    expect(plan.price).toBe(299);
    expect(plan.lines).toEqual([]);
    expect(plan.segmentPrices).toEqual([]);
  });
});

describe('buildQuoteSnapshot', () => {
  const service = {
    pricing_type: 'starting',
    inclusions: ['Labour'],
    exclusions: ['Parts'],
    priceLines: [
      { segment: null, kind: 'labour', name: 'Base', qty: 1, unit_price: 1000, sort_order: 0 },
      { segment: 'SEDAN', kind: 'labour', name: 'Sedan', qty: 1, unit_price: 1300, sort_order: 1 },
    ],
  };

  test('uses the booking segment lines when there are any, else the base lines', () => {
    expect(buildQuoteSnapshot(service, 'SEDAN', 0).lines.map((l) => l.name)).toEqual(['Sedan']);
    expect(buildQuoteSnapshot(service, 'MUV', 0).lines.map((l) => l.name)).toEqual(['Base']);
    expect(buildQuoteSnapshot(service, null, 0).quote).toMatchObject({ pricing_type: 'starting', inclusions: ['Labour'], exclusions: ['Parts'] });
  });

  test('a legacy service snapshots one line at the resolved booking price', () => {
    const snap = buildQuoteSnapshot({ pricing_type: 'fixed', priceLines: [] }, 'SEDAN', 1450);
    expect(snap.lines).toEqual([expect.objectContaining({ name: LEGACY_LINE_NAME, unit_price: 1450, sort_order: 0 })]);
  });

  test('an inspection service snapshots exactly the fee line', () => {
    const snap = buildQuoteSnapshot({ pricing_type: 'inspection', inspection_fee: 299, priceLines: [] }, null, 0);
    expect(snap.lines).toEqual([expect.objectContaining({ kind: 'labour', name: INSPECTION_LINE_NAME, unit_price: 299 })]);
    expect(snap.quote.inspection_fee).toBe(299);
  });

  test('free inspection (fee 0 or null) snapshots NO fee line (owner decision 2026-11-21)', () => {
    for (const fee of [0, null, '0.00']) {
      const snap = buildQuoteSnapshot({ pricing_type: 'inspection', inspection_fee: fee, priceLines: [] }, null, 0);
      expect(snap.lines).toEqual([]);
      expect(snap.quote.inspection_fee).toBe(0);
    }
  });
});

describe('computeCan / buildPricingView', () => {
  const base = {
    vendor_status: 'accepted',
    status: 'confirmed',
    bookingQuote: { pricing_type: 'fixed', lines: [{ id: 1, kind: 'labour', name: 'L', qty: 1, unit_price: 100 }] },
    bookingJob: null,
    extraWorkRequests: [],
    finalBills: [],
    payment: null,
  };

  test('legacy booking -> { flow: legacy } and no flags', () => {
    expect(buildPricingView({ ...base, bookingQuote: null }, 'user')).toEqual({ flow: 'legacy' });
    expect(Object.values(computeCan({ ...base, bookingQuote: null }, 'vendor')).every((v) => v === false)).toBe(true);
  });

  test('vendor: check-in before the job, then work actions; customer can never act for the vendor', () => {
    expect(computeCan(base, 'vendor').check_in).toBe(true);
    expect(computeCan(base, 'user').check_in).toBe(false);
    const started = { ...base, status: 'in_progress', bookingJob: { checked_in_at: new Date() } };
    const can = computeCan(started, 'vendor');
    expect(can).toMatchObject({ check_in: false, start_work: true, request_extra_work: true, issue_bill: true, void_bill: false });
  });

  // Pay-the-garage (2026-11-22): the customer never pays through the app; the vendor marks the bill paid.
  test('customer can never pay online; the vendor can mark an issued bill paid', () => {
    const billed = {
      ...base,
      status: 'in_progress',
      bookingJob: { checked_in_at: new Date() },
      finalBills: [{ id: 1, status: 'issued', total: 100, lines: [] }],
    };
    expect(computeCan(billed, 'user').pay).toBe(false);
    expect(computeCan(billed, 'vendor').issue_bill).toBe(false);
    expect(computeCan(billed, 'vendor').void_bill).toBe(true);
    expect(computeCan(billed, 'vendor').mark_paid).toBe(true);
    expect(computeCan({ ...billed, finalBills: [{ ...billed.finalBills[0], status: 'paid' }] }, 'vendor').mark_paid).toBe(false);
    expect(computeCan({ ...billed, status: 'cancelled' }, 'vendor').mark_paid).toBe(false);
  });
});

describe('booking row helpers', () => {
  test('withPricingFlow derives v2/legacy from the quote and drops the relation', () => {
    expect(withPricingFlow({ id: 1, bookingQuote: { id: 9 } })).toEqual({ id: 1, pricing_flow: 'v2', bill_status: null, bill_total: null });
    expect(withPricingFlow({ id: 2, bookingQuote: null })).toEqual({ id: 2, pricing_flow: 'legacy', bill_status: null, bill_total: null });
    expect(withPricingFlow({ id: 3 })).toEqual({ id: 3, pricing_flow: 'legacy', bill_status: null, bill_total: null });
    // List rows: bill status/total come from the open FinalBill, never from Booking columns.
    const v2 = withPricingFlow({ id: 4, bookingQuote: { id: 1 }, finalBills: [{ status: 'void', total: '1.00' }, { status: 'issued', total: '1234.50' }] });
    expect(v2).toEqual({ id: 4, pricing_flow: 'v2', bill_status: 'issued', bill_total: 1234.5 });
    expect(withPricingFlow({ id: 5, bookingQuote: { id: 1 }, finalBills: [] })).toMatchObject({ bill_status: null, bill_total: null });
    // a legacy row never reports a bill even if finalBills were included
    expect(withPricingFlow({ id: 6, bookingQuote: null, finalBills: [{ status: 'paid', total: 5 }] })).toMatchObject({ pricing_flow: 'legacy', bill_status: null });
  });

  test('the bill object carries the quote tax_inclusive flag', () => {
    const bill = { id: 1, number: 'KPX-2026-000001', status: 'issued', lines: [], total: 10 };
    expect(billOut(bill, { tax_inclusive: false }).tax_inclusive).toBe(false);
    expect(billOut(bill).tax_inclusive).toBe(true);
    expect(billOut(null)).toBeNull();
  });
});
