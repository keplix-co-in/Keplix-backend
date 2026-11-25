/**
 * Pricing v2 money math (util/billMath.js). Pure functions, no mocks.
 * The examples are the ones in docs/PRICING_V2_API.md.
 */
import {
  toPaise,
  fromPaise,
  lineTotal,
  lineTotalPaise,
  summarizeLines,
  inspectionWaiverPaise,
  buildBillLines,
  WAIVER_LINE_NAME,
} from '../../util/billMath.js';

const decimal = (v) => ({ toString: () => String(v) }); // Prisma Decimal stand-in

describe('paise conversion', () => {
  test('rupees <-> paise, including strings and Decimals', () => {
    expect(toPaise(1499)).toBe(149900);
    expect(toPaise('0.1')).toBe(10);
    expect(toPaise(decimal('2800.50'))).toBe(280050);
    expect(fromPaise(149900)).toBe(1499);
    expect(fromPaise(-0)).toBe(0);
  });

  test('no float drift: 0.1 + 0.2 is exactly 0.3 in a bill', () => {
    const { total } = summarizeLines([
      { kind: 'labour', qty: 1, unit_price: 0.1 },
      { kind: 'labour', qty: 1, unit_price: 0.2 },
    ]);
    expect(total).toBe(0.3);
  });

  test('line totals round once, to the paisa', () => {
    expect(lineTotal(2, 1499)).toBe(2998);
    expect(lineTotal(1.5, 333.33)).toBe(500); // 499.995 -> 500.00
    expect(lineTotalPaise(3, 0.01)).toBe(3);
  });

  test('rejects a non-numeric amount', () => {
    expect(() => toPaise('abc')).toThrow(TypeError);
  });
});

describe('buildBillLines', () => {
  test('free inspection: zero quote lines, repairs approved -> no fee or waiver line (2026-11-21)', () => {
    const quote = { pricing_type: 'inspection', inspection_fee: 0 };
    expect(buildBillLines({ quote, quoteLines: [] })).toMatchObject({ lines: [], total: 0, totalPaise: 0 });
    const out = buildBillLines({ quote, quoteLines: [], approvedItems: [{ id: 9, kind: 'labour', name: 'Repair', qty: 1, unit_price: 500, line_total: 500 }] });
    expect(out.lines.map((l) => l.name)).toEqual(['Repair']);
    expect(out.total).toBe(500);
  });

  const quoteLines = [
    { id: 1, kind: 'labour', name: 'Brake service', qty: 1, unit_price: 3000 },
    { id: 2, kind: 'part', name: 'Brake fluid', qty: 2, unit_price: 1000 },
  ];

  test('Rs 5,000 quote + Rs 2,800 approved extra = Rs 7,800', () => {
    const bill = buildBillLines({
      quote: { pricing_type: 'fixed' },
      quoteLines,
      approvedItems: [{ id: 9, kind: 'part', name: 'Brake pads', qty: 1, unit_price: 2800, line_total: 2800 }],
    });
    expect(bill.total).toBe(7800);
    expect(bill.labour_total).toBe(3000);
    expect(bill.parts_total).toBe(4800);
    expect(bill.totalPaise).toBe(780000);
    expect(bill.lines.map((l) => l.source)).toEqual(['quote', 'quote', 'extra']);
  });

  test('a removal line is negative and lowers the kind of the line it removes', () => {
    const bill = buildBillLines({
      quote: { pricing_type: 'fixed' },
      quoteLines,
      approvedItems: [{ id: 10, kind: 'removal', name: 'Remove: Brake fluid', qty: 2, unit_price: -1000, line_total: -2000, quote_line_id: 2 }],
    });
    const removal = bill.lines.find((l) => l.kind === 'removal');
    expect(removal.line_total).toBe(-2000);
    expect(bill.parts_total).toBe(0);
    expect(bill.labour_total).toBe(3000);
    expect(bill.total).toBe(3000);
  });

  test('the same quote line is only removed once', () => {
    const removal = { kind: 'removal', name: 'Remove', qty: 2, unit_price: -1000, line_total: -2000, quote_line_id: 2 };
    const bill = buildBillLines({
      quote: { pricing_type: 'fixed' },
      quoteLines,
      approvedItems: [{ ...removal, id: 10 }, { ...removal, id: 11 }],
    });
    expect(bill.lines.filter((l) => l.kind === 'removal')).toHaveLength(1);
    expect(bill.total).toBe(3000);
  });

  test('the total is floored at 0', () => {
    const bill = buildBillLines({
      quote: { pricing_type: 'fixed' },
      quoteLines: [{ id: 1, kind: 'labour', name: 'Wash', qty: 1, unit_price: 100 }],
      approvedItems: [
        { id: 5, kind: 'removal', name: 'Remove', qty: 1, unit_price: -100, line_total: -100, quote_line_id: 1 },
        { id: 6, kind: 'removal', name: 'Bogus', qty: 1, unit_price: -500, line_total: -500, quote_line_id: 99 },
      ],
    });
    expect(bill.total).toBe(0);
    expect(bill.labour_total).toBe(0);
  });

  describe('inspection fee waiver (Rs 299)', () => {
    const quote = { pricing_type: 'inspection', inspection_fee: 299 };
    const inspectionLines = [{ id: 1, kind: 'labour', name: 'Inspection fee', qty: 1, unit_price: 299 }];

    test('approved repairs >= the fee waive it', () => {
      const bill = buildBillLines({
        quote,
        quoteLines: inspectionLines,
        approvedItems: [{ id: 7, kind: 'labour', name: 'Fix', qty: 1, unit_price: 299, line_total: 299 }],
      });
      const waiver = bill.lines.find((l) => l.source === 'waiver');
      expect(waiver).toMatchObject({ kind: 'labour', name: WAIVER_LINE_NAME, qty: 1, unit_price: -299, line_total: -299 });
      expect(bill.total).toBe(299);
    });

    test('approved repairs below the fee do not waive it', () => {
      const bill = buildBillLines({
        quote,
        quoteLines: inspectionLines,
        approvedItems: [{ id: 7, kind: 'labour', name: 'Fix', qty: 1, unit_price: 298.99, line_total: 298.99 }],
      });
      expect(bill.lines.some((l) => l.source === 'waiver')).toBe(false);
      expect(bill.total).toBe(597.99);
    });

    test('removals do not count towards the waiver threshold', () => {
      expect(
        inspectionWaiverPaise(quote, [{ kind: 'removal', qty: 1, unit_price: -500, line_total: -500 }])
      ).toBe(0);
    });

    test('no waiver for non-inspection quotes or a Rs 0 fee', () => {
      const items = [{ kind: 'labour', qty: 1, unit_price: 1000 }];
      expect(inspectionWaiverPaise({ pricing_type: 'fixed', inspection_fee: 299 }, items)).toBe(0);
      expect(inspectionWaiverPaise({ pricing_type: 'inspection', inspection_fee: 0 }, items)).toBe(0);
    });
  });
});
