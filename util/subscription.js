/**
 * Garage subscriptions (docs/SUBSCRIPTIONS_API.md).
 *
 * WHY (owner decision 2026-11-22): customers now pay the garage directly, and
 * the payment gateway is used only for garage subscriptions. Whether a garage
 * is listed to customers is therefore decided here, from its subscription.
 *
 * Status is DERIVED from ends_at, never stored, so it can't go stale:
 *   now <  ends_at            -> 'trial' (period 'trial') or 'active'
 *   now <  ends_at + 7 days   -> 'grace'   (reminders, still listed)
 *   otherwise                 -> 'expired' (hidden from customers, no new bookings)
 */
import prisma from './prisma.js';

export const GRACE_DAYS = 7;
export const TRIAL_DAYS = 90; // owner decision 2026-11-23: 90 days of Gold for every vendor
export const TRIAL_PLAN_CODE = 'gold';
export const PERIOD_DAYS = { monthly: 30, yearly: 365 };
export const PAID_PERIODS = Object.keys(PERIOD_DAYS);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Seed values (contract). Inserted only when a code is missing; admin edits win. */
export const DEFAULT_PLANS = [
  {
    code: 'silver', name: 'Silver', monthly_price: 499, yearly_price: 4990, sort_order: 1,
    features: ['Listing in your area', 'Up to 30 bookings a month', 'Bills and job tools'],
  },
  {
    code: 'gold', name: 'Gold', monthly_price: 999, yearly_price: 9990, sort_order: 2,
    features: ['Priority listing in your area', 'Unlimited bookings', 'Bills, invoices & job tools', 'Customer reviews badge'],
  },
  {
    code: 'platinum', name: 'Platinum', monthly_price: 1999, yearly_price: 19990, sort_order: 3,
    features: ['Everything in Gold', 'Top of your area', 'Featured badge', '₹500 ad credit'],
  },
];

const ms = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** 'trial' | 'active' | 'grace' | 'expired'. now == ends_at is already grace; now == ends_at + 7d is expired. */
export const subscriptionStatus = (sub, now = new Date()) => {
  const ends = ms(sub.ends_at);
  const t = ms(now);
  if (t < ends) return sub.period === 'trial' ? 'trial' : 'active';
  if (t < ends + GRACE_DAYS * DAY_MS) return 'grace';
  return 'expired';
};

/** Renewal: the new period is added on top of max(now, ends_at), so paying early loses nothing. */
export const computeRenewal = (sub, period, now = new Date()) => {
  const days = PERIOD_DAYS[period];
  if (!days) throw new Error(`Unknown subscription period: ${period}`);
  const base = Math.max(ms(now), ms(sub.ends_at));
  const stillRunning = ms(sub.ends_at) > ms(now);
  return {
    starts_at: stillRunning ? sub.starts_at : new Date(ms(now)),
    ends_at: new Date(base + days * DAY_MS),
  };
};

/** Seeds missing plans (no hand SQL needed). Never overwrites an admin's edits. */
let plansSeeded = false;
export const ensurePlansSeeded = async (db = prisma) => {
  if (plansSeeded) return;
  const existing = await db.subscriptionPlan.findMany({ select: { code: true } });
  const have = new Set(existing.map((p) => p.code));
  for (const plan of DEFAULT_PLANS) {
    if (have.has(plan.code)) continue;
    try {
      await db.subscriptionPlan.create({ data: { ...plan, is_active: true } });
    } catch (err) {
      // Two first-ever requests raced to seed: the other one won, which is fine
      // (without this the loser got a 500 on a unique-code violation).
      if (err?.code !== 'P2002') throw err;
    }
  }
  plansSeeded = true;
};
export const __resetPlanSeedCache = () => { plansSeeded = false; };

/** The vendor's subscription; the 90-day Gold trial row is created lazily on first read. */
export const getOrCreateSubscription = async (vendorId, now = new Date(), db = prisma) => {
  const found = await db.vendorSubscription.findUnique({ where: { vendorId } });
  if (found) return found;
  try {
    return await db.vendorSubscription.create({
      data: {
        vendorId,
        plan_code: TRIAL_PLAN_CODE,
        period: 'trial',
        starts_at: new Date(ms(now)),
        ends_at: new Date(ms(now) + TRIAL_DAYS * DAY_MS),
      },
    });
  } catch (err) {
    // Two requests raced to create the trial row: use the winner's.
    if (err?.code === 'P2002') return db.vendorSubscription.findUnique({ where: { vendorId } });
    throw err;
  }
};

/** Shape returned by GET /subscriptions/me. */
export const describeSubscription = (sub, plan, now = new Date()) => {
  const status = subscriptionStatus(sub, now);
  const ends = ms(sub.ends_at);
  return {
    plan_code: sub.plan_code,
    plan_name: plan?.name ?? sub.plan_code,
    period: sub.period,
    status,
    starts_at: new Date(ms(sub.starts_at)).toISOString(),
    ends_at: new Date(ends).toISOString(),
    grace_ends_at: new Date(ends + GRACE_DAYS * DAY_MS).toISOString(),
    // Whole days until ends_at, never negative (a garage in grace shows 0).
    days_left: Math.max(0, Math.ceil((ends - ms(now)) / DAY_MS)),
  };
};

/** Customer-facing visibility: everything except 'expired'. */
export const isVendorVisible = async (vendorId, now = new Date(), db = prisma) => {
  const sub = await getOrCreateSubscription(vendorId, now, db);
  return subscriptionStatus(sub, now) !== 'expired';
};

/**
 * Prisma `where` fragment for a User (vendor) filter: spread it next to
 * `vendorProfile`, e.g. `vendor: { vendorProfile: {...}, ...visibleVendorWhere() }`.
 * A vendor with no row yet is still inside the lazy trial, so it is visible.
 */
export const visibleVendorWhere = (now = new Date()) => ({
  OR: [
    { vendorSubscription: { is: null } },
    { vendorSubscription: { is: { ends_at: { gt: new Date(ms(now) - GRACE_DAYS * DAY_MS) } } } },
  ],
});

/** Same rule for the raw-SQL listing queries. `column` is a fixed identifier from our code, never user input. */
export const visibleVendorSql = (Prisma, column, now = new Date()) =>
  Prisma.sql`NOT EXISTS (SELECT 1 FROM "VendorSubscription" vsub WHERE vsub."vendorId" = ${Prisma.raw(column)} AND vsub.ends_at <= ${new Date(ms(now) - GRACE_DAYS * DAY_MS)})`;
