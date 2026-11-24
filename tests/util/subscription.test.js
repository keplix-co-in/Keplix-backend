import { jest } from '@jest/globals';

// Pure helpers take a db argument, but the module imports util/prisma.js; mock it so no DB is touched.
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: {} }));

const sub = await import('../../util/subscription.js');
const { Prisma } = await import('@prisma/client');

const DAY = 24 * 60 * 60 * 1000;
const ENDS = new Date('2026-12-01T00:00:00.000Z');
const at = (offsetMs) => new Date(ENDS.getTime() + offsetMs);
const row = (over = {}) => ({ period: 'monthly', plan_code: 'gold', starts_at: new Date('2026-11-01T00:00:00Z'), ends_at: ENDS, ...over });

describe('subscriptionStatus (derived, never stored)', () => {
  test('before ends_at: active for a paid period, trial for the trial period', () => {
    expect(sub.subscriptionStatus(row(), at(-1))).toBe('active');
    expect(sub.subscriptionStatus(row({ period: 'yearly' }), at(-DAY))).toBe('active');
    expect(sub.subscriptionStatus(row({ period: 'trial' }), at(-1))).toBe('trial');
  });

  test('now == ends_at is already grace (boundary)', () => {
    expect(sub.subscriptionStatus(row(), at(0))).toBe('grace');
    expect(sub.subscriptionStatus(row({ period: 'trial' }), at(0))).toBe('grace');
  });

  test('last millisecond before ends_at + 7d is grace; exactly ends_at + 7d is expired (boundary)', () => {
    expect(sub.subscriptionStatus(row(), at(7 * DAY - 1))).toBe('grace');
    expect(sub.subscriptionStatus(row(), at(7 * DAY))).toBe('expired');
    expect(sub.subscriptionStatus(row(), at(30 * DAY))).toBe('expired');
  });

  test('accepts ISO strings for dates', () => {
    expect(sub.subscriptionStatus({ ...row(), ends_at: ENDS.toISOString() }, at(-1))).toBe('active');
  });
});

describe('computeRenewal: extends from max(now, ends_at)', () => {
  test('still running: the new period is added to ends_at (paying early loses nothing); starts_at kept', () => {
    const r = sub.computeRenewal(row(), 'monthly', at(-10 * DAY));
    expect(r.ends_at.getTime()).toBe(ENDS.getTime() + 30 * DAY);
    expect(r.starts_at).toEqual(row().starts_at);
  });

  test('lapsed (grace/expired): the period starts from now', () => {
    const now = at(3 * DAY);
    const r = sub.computeRenewal(row(), 'yearly', now);
    expect(r.ends_at.getTime()).toBe(now.getTime() + 365 * DAY);
    expect(r.starts_at.getTime()).toBe(now.getTime());
  });

  test('now == ends_at: base is the same either way', () => {
    expect(sub.computeRenewal(row(), 'monthly', at(0)).ends_at.getTime()).toBe(ENDS.getTime() + 30 * DAY);
  });

  test('unknown period throws', () => {
    expect(() => sub.computeRenewal(row(), 'weekly', ENDS)).toThrow(/Unknown subscription period/);
  });
});

describe('describeSubscription', () => {
  test('exact shape; days_left never negative; grace_ends_at = ends_at + 7d', () => {
    const d = sub.describeSubscription(row(), { name: 'Gold' }, at(-2 * DAY - 1000));
    expect(d).toEqual({
      plan_code: 'gold', plan_name: 'Gold', period: 'monthly', status: 'active',
      starts_at: '2026-11-01T00:00:00.000Z', ends_at: ENDS.toISOString(),
      grace_ends_at: new Date(ENDS.getTime() + 7 * DAY).toISOString(), days_left: 3,
    });
    expect(sub.describeSubscription(row(), null, at(2 * DAY)).days_left).toBe(0);
    expect(sub.describeSubscription(row(), null, at(2 * DAY)).plan_name).toBe('gold');
  });
});

describe('getOrCreateSubscription (lazy 90-day Gold trial)', () => {
  const NOW = new Date('2026-11-23T10:00:00.000Z');
  test('returns the existing row without creating', async () => {
    const db = { vendorSubscription: { findUnique: jest.fn().mockResolvedValue({ id: 1 }), create: jest.fn() } };
    expect(await sub.getOrCreateSubscription(5, NOW, db)).toEqual({ id: 1 });
    expect(db.vendorSubscription.create).not.toHaveBeenCalled();
  });

  test('creates a trial: gold, period trial, ends_at = now + 90d', async () => {
    const db = { vendorSubscription: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(async ({ data }) => data) } };
    const out = await sub.getOrCreateSubscription(5, NOW, db);
    expect(out).toMatchObject({ vendorId: 5, plan_code: 'gold', period: 'trial' });
    expect(out.ends_at.getTime()).toBe(NOW.getTime() + 90 * DAY);
    expect(sub.subscriptionStatus(out, NOW)).toBe('trial');
  });

  test('a create race (P2002) falls back to the winning row', async () => {
    const winner = { id: 9 };
    const db = {
      vendorSubscription: {
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
      },
    };
    expect(await sub.getOrCreateSubscription(5, NOW, db)).toBe(winner);
  });

  test('other create errors propagate', async () => {
    const db = { vendorSubscription: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockRejectedValue(new Error('boom')) } };
    await expect(sub.getOrCreateSubscription(5, NOW, db)).rejects.toThrow('boom');
  });
});

describe('isVendorVisible', () => {
  const dbWith = (s) => ({ vendorSubscription: { findUnique: jest.fn().mockResolvedValue(s), create: jest.fn() } });
  test('visible while trial, active and grace; hidden once expired', async () => {
    expect(await sub.isVendorVisible(1, at(-1), dbWith(row()))).toBe(true);
    expect(await sub.isVendorVisible(1, at(0), dbWith(row()))).toBe(true);
    expect(await sub.isVendorVisible(1, at(7 * DAY - 1), dbWith(row()))).toBe(true);
    expect(await sub.isVendorVisible(1, at(7 * DAY), dbWith(row()))).toBe(false);
  });
});

describe('visibility filters for listings', () => {
  test('visibleVendorWhere: no row (lazy trial) OR ends_at within the grace window', () => {
    const w = sub.visibleVendorWhere(at(0));
    expect(w.OR[0]).toEqual({ vendorSubscription: { is: null } });
    expect(w.OR[1].vendorSubscription.is.ends_at.gt.getTime()).toBe(ENDS.getTime() - 7 * DAY);
  });

  test('visibleVendorSql: NOT EXISTS over expired rows, fixed column identifier, bound cutoff', () => {
    const frag = sub.visibleVendorSql(Prisma, 'vp."userId"', at(0));
    expect(frag.sql).toContain('NOT EXISTS');
    expect(frag.sql).toContain('"VendorSubscription"');
    expect(frag.sql).toContain('vp."userId"');
    expect(frag.sql).toContain('ends_at <=');
    expect(frag.values[0].getTime()).toBe(ENDS.getTime() - 7 * DAY);
  });
});

describe('ensurePlansSeeded', () => {
  beforeEach(() => sub.__resetPlanSeedCache());
  test('inserts only missing plans and never overwrites an existing one', async () => {
    const db = { subscriptionPlan: { findMany: jest.fn().mockResolvedValue([{ code: 'gold' }]), create: jest.fn() } };
    await sub.ensurePlansSeeded(db);
    const codes = db.subscriptionPlan.create.mock.calls.map((c) => c[0].data.code);
    expect(codes).toEqual(['silver', 'platinum']);
    await sub.ensurePlansSeeded(db); // cached
    expect(db.subscriptionPlan.findMany).toHaveBeenCalledTimes(1);
  });

  test('concurrent first calls: a P2002 on create (the other request won) is swallowed', async () => {
    const err = Object.assign(new Error('dup'), { code: 'P2002' });
    const db = { subscriptionPlan: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockRejectedValueOnce(err).mockResolvedValue({}) } };
    await expect(sub.ensurePlansSeeded(db)).resolves.toBeUndefined();
    expect(db.subscriptionPlan.create).toHaveBeenCalledTimes(3);
  });

  test('other create errors still propagate and the seed is retried next time', async () => {
    const db = { subscriptionPlan: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockRejectedValue(new Error('db down')) } };
    await expect(sub.ensurePlansSeeded(db)).rejects.toThrow('db down');
    await expect(sub.ensurePlansSeeded(db)).rejects.toThrow('db down');
    expect(db.subscriptionPlan.findMany).toHaveBeenCalledTimes(2);
  });

  test('contract seed prices', () => {
    const p = Object.fromEntries(sub.DEFAULT_PLANS.map((x) => [x.code, [x.monthly_price, x.yearly_price]]));
    expect(p).toEqual({ silver: [499, 4990], gold: [999, 9990], platinum: [1999, 19990] });
  });
});
