import { jest } from '@jest/globals';

/**
 * settlePendingRefunds (2026-11-03): refunds Razorpay accepted as 'pending'
 * get finished by asking Razorpay, in case the webhook never arrived. It only
 * reads Razorpay; it must never call the refund API itself.
 */

const mockPrisma = { refund: { findMany: jest.fn() } };
const mockFetch = jest.fn();
const mockApply = jest.fn();

jest.unstable_mockModule('node-cron', () => ({ default: { schedule: jest.fn() } }));
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../services/refundService.js', () => ({
  fetchGatewayRefund: mockFetch,
  applyGatewayRefundOutcome: mockApply,
}));

const reconciler = (await import('../../util/refundReconciler.js')).default;

const row = (id) => ({ id, paymentId: id, status: 'gateway_confirmed', gatewayRefundId: `rfnd_${id}` });

beforeEach(() => {
  jest.clearAllMocks();
  mockApply.mockResolvedValue({ changed: true });
});

test('only looks at gateway_confirmed refunds with a Razorpay id, older than the wait', async () => {
  mockPrisma.refund.findMany.mockResolvedValue([]);
  await reconciler.settlePendingRefunds();
  const { where } = mockPrisma.refund.findMany.mock.calls[0][0];
  expect(where.status).toBe('gateway_confirmed');
  expect(where.gatewayRefundId).toEqual({ not: null });
  expect(where.updatedAt.lt).toBeInstanceOf(Date);
  expect(where.updatedAt.lt.getTime()).toBeLessThan(Date.now() - 9 * 60 * 1000);
});

test('applies Razorpay\'s answer: processed, failed, or leaves pending alone', async () => {
  mockPrisma.refund.findMany.mockResolvedValue([row(1), row(2), row(3)]);
  mockFetch.mockImplementation(async (id) => ({
    rfnd_1: { id, status: 'processed' },
    rfnd_2: { id, status: 'failed' },
    rfnd_3: { id, status: 'pending' },
  })[id]);

  const result = await reconciler.settlePendingRefunds();

  expect(mockApply).toHaveBeenCalledTimes(2);
  expect(mockApply).toHaveBeenCalledWith(row(1), 'processed', { id: 'rfnd_1', status: 'processed' });
  expect(mockApply).toHaveBeenCalledWith(row(2), 'failed', { id: 'rfnd_2', status: 'failed' });
  expect(result).toEqual({ checked: 3, processed: 1, failed: 1 });
});

test('one failed lookup does not stop the others', async () => {
  mockPrisma.refund.findMany.mockResolvedValue([row(1), row(2)]);
  mockFetch
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce({ id: 'rfnd_2', status: 'processed' });

  const result = await reconciler.settlePendingRefunds();

  expect(mockApply).toHaveBeenCalledTimes(1);
  expect(result.processed).toBe(1);
});
