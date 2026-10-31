import { jest } from '@jest/globals';

const mockPrisma = { user: { findMany: jest.fn(), deleteMany: jest.fn() } };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const mockLogger = { info: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../util/logger.js', () => ({ default: mockLogger }));

const mockDestroy = jest.fn();
jest.unstable_mockModule('../../util/cloudinary.js', () => ({
  destroyAsset: mockDestroy,
  publicIdFromUrl: (u) => `pid:${u}`,
  default: {},
}));

const mockSchedule = jest.fn(() => ({ stop: jest.fn() }));
jest.unstable_mockModule('node-cron', () => ({ default: { schedule: mockSchedule } }));

const {
  buildAbandonedWhere,
  pruneAbandonedAccounts,
  scheduleAbandonedAccountCleanup,
  stopAbandonedAccountCleanup,
  RETENTION_DAYS,
} = await import('../../queues/abandonedAccountCleanup.js');

const NOW = new Date('2026-10-31T00:00:00Z');

beforeEach(() => jest.clearAllMocks());

describe('buildAbandonedWhere', () => {
  const cutoff = new Date('2026-10-24T00:00:00Z');
  const w = buildAbandonedWhere(cutoff);

  it('only matches old, non-admin accounts with no bookings', () => {
    expect(w.createdAt).toEqual({ lt: cutoff });
    expect(w.role).toEqual({ in: ['user', 'vendor'] });
    expect(w.bookings).toEqual({ none: {} });
    expect(w.phoneIdentity).toEqual({ is: null });
  });

  it('covers customers with no profile or an empty phone', () => {
    const user = w.OR.find((b) => b.role === 'user');
    expect(user.OR).toEqual([
      { userProfile: { is: null } },
      { userProfile: { is: { OR: [{ phone: null }, { phone: '' }] } } },
    ]);
  });

  it('never touches a vendor with services, walk-ins, health sheets or a finished onboarding', () => {
    const vendor = w.OR.find((b) => b.role === 'vendor');
    expect(vendor.services).toEqual({ none: {} });
    expect(vendor.vendorWalkInJobs).toEqual({ none: {} });
    expect(vendor.healthSheets).toEqual({ none: {} });
    expect(vendor.OR[1]).toEqual({
      vendorProfile: { is: { onboarding_completed: false, phone: '' } },
    });
  });
});

describe('pruneAbandonedAccounts', () => {
  it('uses a cutoff RETENTION_DAYS before now', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    await pruneAbandonedAccounts({ now: NOW });
    const { where } = mockPrisma.user.findMany.mock.calls[0][0];
    expect(where.createdAt.lt.getTime()).toBe(NOW.getTime() - RETENTION_DAYS * 86400000);
  });

  it('does not delete anything when there are no candidates', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    const r = await pruneAbandonedAccounts({ now: NOW });
    expect(mockPrisma.user.deleteMany).not.toHaveBeenCalled();
    expect(r).toEqual({ candidates: 0, deleted: 0, assetsFailed: 0 });
  });

  it('deletes candidates, re-checking the same filter', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 1, userProfile: { profile_picture: 'a' }, vendorProfile: null },
      { id: 2, userProfile: null, vendorProfile: { image: 'b', cover_image: null } },
    ]);
    mockDestroy.mockResolvedValue(true);
    mockPrisma.user.deleteMany.mockResolvedValue({ count: 2 });

    const r = await pruneAbandonedAccounts({ now: NOW });

    expect(mockDestroy).toHaveBeenCalledWith('pid:a');
    expect(mockDestroy).toHaveBeenCalledWith('pid:b');
    const { where } = mockPrisma.user.deleteMany.mock.calls[0][0];
    expect(where.id).toEqual({ in: [1, 2] });
    expect(where.bookings).toEqual({ none: {} });
    expect(r).toEqual({ candidates: 2, deleted: 2, assetsFailed: 0 });
  });

  it('still deletes the rows when Cloudinary fails', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 3, userProfile: { profile_picture: 'x', id_proof_front: 'y' }, vendorProfile: null },
    ]);
    mockDestroy.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(false);
    mockPrisma.user.deleteMany.mockResolvedValue({ count: 1 });

    const r = await pruneAbandonedAccounts({ now: NOW });
    expect(mockPrisma.user.deleteMany).toHaveBeenCalled();
    expect(r.assetsFailed).toBe(2);
  });
});

describe('scheduling', () => {
  it('schedules once, daily', async () => {
    await scheduleAbandonedAccountCleanup();
    await scheduleAbandonedAccountCleanup();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0][0]).toBe('30 3 * * *');
    stopAbandonedAccountCleanup();
  });
});
