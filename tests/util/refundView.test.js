import { buildRefundView, REFUND_ETA_HOURS } from '../../util/refundView.js';

// No mocks needed — buildRefundView is pure.

const decimal = (v) => ({ toString: () => String(v) });

function paymentFixture(overrides = {}) {
  return {
    id: 1,
    status: 'success',
    amount: decimal('799'),
    refunds: [],
    ...overrides,
  };
}

function refundFixture(overrides = {}) {
  return {
    id: 1,
    amount: decimal('780.14'),
    status: 'processed',
    createdAt: new Date('2026-08-17T10:00:00Z'),
    ...overrides,
  };
}

describe('buildRefundView', () => {
  // The unpaid decision: showing refund language to someone who never paid is
  // what generates "where is my refund" tickets.
  test('returns null when there is no payment', () => {
    expect(buildRefundView({ booking: { status: 'cancelled' }, payment: null })).toBeNull();
  });

  test('returns null when the payment never succeeded', () => {
    const view = buildRefundView({
      booking: { status: 'cancelled' },
      payment: paymentFixture({ status: 'pending' }),
    });
    expect(view).toBeNull();
  });

  test('returns null for a paid booking that was never cancelled and has no refunds', () => {
    const view = buildRefundView({
      booking: { status: 'confirmed' },
      payment: paymentFixture(),
    });
    expect(view).toBeNull();
  });

  // Paid + cancelled + nothing refunded = the late-cancellation case.
  test('reports under_review for a paid cancellation with no refund row', () => {
    const view = buildRefundView({
      booking: { status: 'cancelled' },
      payment: paymentFixture(),
    });

    expect(view.status).toBe('under_review');
    // Critical: no figure, because no amount has been committed to.
    expect(view.amount).toBeNull();
    expect(view.message).toMatch(/reviewing/i);
  });

  test('accepts the "canceled" spelling as well as "cancelled"', () => {
    const view = buildRefundView({
      booking: { status: 'canceled' },
      payment: paymentFixture(),
    });
    expect(view.status).toBe('under_review');
  });

  test('reports processing while a refund is still in flight', () => {
    const view = buildRefundView({
      booking: { status: 'cancelled' },
      payment: paymentFixture({ refunds: [refundFixture({ status: 'gateway_confirmed' })] }),
    });

    expect(view.status).toBe('processing');
    expect(view.amount).toBeCloseTo(780.14, 2);
    expect(view.expectedBy).toEqual(
      new Date(new Date('2026-08-17T10:00:00Z').getTime() + REFUND_ETA_HOURS * 3600 * 1000),
    );
  });

  test('reports completed once the gateway has processed it', () => {
    const view = buildRefundView({
      booking: { status: 'cancelled' },
      payment: paymentFixture({ refunds: [refundFixture()] }),
    });

    expect(view.status).toBe('completed');
    expect(view.amount).toBeCloseTo(780.14, 2);
  });

  // The money moved; only our bookkeeping failed. That is not the customer's
  // problem and must not be shown as one.
  test('treats reconciliation_needed as completed for the customer', () => {
    const view = buildRefundView({
      booking: { status: 'cancelled' },
      payment: paymentFixture({ refunds: [refundFixture({ status: 'reconciliation_needed' })] }),
    });

    expect(view.status).toBe('completed');
  });

  // gateway_failed released its claim — the customer has NOT been refunded.
  test('reports failed, with no amount, when every refund failed at the gateway', () => {
    const view = buildRefundView({
      booking: { status: 'cancelled' },
      payment: paymentFixture({ refunds: [refundFixture({ status: 'gateway_failed' })] }),
    });

    expect(view.status).toBe('failed');
    expect(view.amount).toBeNull();
    expect(view.message).toMatch(/support/i);
  });

  test('excludes failed refunds from the total when a retry succeeded', () => {
    const view = buildRefundView({
      booking: { status: 'cancelled' },
      payment: paymentFixture({
        refunds: [
          refundFixture({ id: 1, status: 'gateway_failed', amount: decimal('780.14') }),
          refundFixture({ id: 2, status: 'processed', amount: decimal('780.14') }),
        ],
      }),
    });

    expect(view.status).toBe('completed');
    // Not 1560.28 — the failed attempt never moved money.
    expect(view.amount).toBeCloseTo(780.14, 2);
  });

  test('uses the earliest refund as the start of the ETA window', () => {
    const early = new Date('2026-08-17T09:00:00Z');
    const view = buildRefundView({
      booking: { status: 'cancelled' },
      payment: paymentFixture({
        refunds: [
          refundFixture({ id: 1, createdAt: new Date('2026-08-17T12:00:00Z'), amount: decimal('10') }),
          refundFixture({ id: 2, createdAt: early, amount: decimal('20') }),
        ],
      }),
    });

    expect(view.initiatedAt).toEqual(early);
    expect(view.amount).toBeCloseTo(30, 2);
  });
});
