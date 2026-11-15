import prisma from "../../util/prisma.js";
import { GATEWAY_REACHED_STATUSES } from "../../services/refundService.js";
import { fetchMetaAds, fetchInstagram, fetchGoogle, fetchWhatsApp } from "../../services/founderSources.js";
import { getBrief, ask, buildContext } from "../../services/founderAI.js";

/**
 * Founder dashboard (2026-11-14, owner request; super_admin only, READ-ONLY).
 *
 * GET /admin/founder/sales -- the numbers behind the admin panel's
 * Founder → Sales and Founder → Today cards, computed from our own Payment /
 * Refund tables (Razorpay is the source those rows were written from, so this
 * needs no Razorpay key and makes no gateway call).
 *
 * Days are India days (IST, UTC+5:30), because "yesterday's sales" means the
 * owner's yesterday, not UTC's. Volume is small, so the last 60 days of rows
 * are read once and bucketed in JS rather than via raw SQL date math.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A payment counts as money collected once it succeeded, even if it was later
// refunded -- same rule as getFinanceKpis' totalCollected; refunds are shown
// separately rather than by hiding the payment.
const COLLECTED = ["success", "refunded"];

/** 'YYYY-MM-DD' of the IST calendar day containing `date`. */
export const istDayKey = (date) =>
  new Date(new Date(date).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** UTC instant of 00:00 IST on the IST day containing `now`. */
const istMidnight = (now) => {
  const key = istDayKey(now);
  return new Date(Date.parse(`${key}T00:00:00.000Z`) - IST_OFFSET_MS);
};

const num = (v) => Number(v ?? 0);

/** The sales numbers, shared by GET /founder/sales and the AI snapshot. */
export const computeFounderSales = async () => {
  const now = new Date();
  const todayStart = istMidnight(now);
  // 60-day chart = today + previous 59 days (2026-11-14 owner request): the UI
  // shows 7/14/30 days AND compares each against the previous period of the
  // same length, so 30 + 30 days are needed. Failed payments and refunds stay a
  // 14-day list, so they are filtered to `since14` below.
  const CHART_DAYS = 60;
  const since = new Date(todayStart.getTime() - (CHART_DAYS - 1) * DAY_MS);
  const since14 = new Date(todayStart.getTime() - 14 * DAY_MS);

  const [payments, refunds] = await Promise.all([
    prisma.payment.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true, amount: true, status: true, method: true, bookingId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.refund.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true, paymentId: true, amount: true, status: true, reason: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Day buckets, oldest first (today last), for the chart.
  const days = [];
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const key = istDayKey(new Date(todayStart.getTime() - i * DAY_MS + 1));
    days.push({ date: key, amount: 0, count: 0 });
  }
  const byKey = Object.fromEntries(days.map((d) => [d.date, d]));
  const totals = {}; // every day in range, incl. day -8 for the comparison
  for (const p of payments) {
    if (!COLLECTED.includes(p.status)) continue;
    const key = istDayKey(p.createdAt);
    totals[key] = totals[key] || { amount: 0, count: 0 };
    totals[key].amount += num(p.amount);
    totals[key].count += 1;
    if (byKey[key]) {
      byKey[key].amount += num(p.amount);
      byKey[key].count += 1;
    }
  }

  const keyAt = (daysBack) => istDayKey(new Date(todayStart.getTime() - daysBack * DAY_MS + 1));
  const pick = (daysBack) => totals[keyAt(daysBack)] || { amount: 0, count: 0 };

  const failed = payments
    .filter((p) => p.status === "failed" && new Date(p.createdAt) >= since14)
    .slice(0, 20)
    .map((p) => ({ id: p.id, amount: num(p.amount), method: p.method, bookingId: p.bookingId, createdAt: p.createdAt }));

  const refundRows = refunds
    .filter((r) => GATEWAY_REACHED_STATUSES.includes(r.status) && new Date(r.createdAt) >= since14)
    .slice(0, 20)
    .map((r) => ({ id: r.id, paymentId: r.paymentId, amount: num(r.amount), status: r.status, reason: r.reason, createdAt: r.createdAt }));

  return {
    today: pick(0),
    yesterday: pick(1),
    sameDayLastWeek: pick(8),
    chart: days,
    failed,
    refunds: refundRows,
    generatedAt: now.toISOString(),
  };
};

export const getFounderSales = async (req, res) => {
  try {
    res.json(await computeFounderSales());
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to load founder sales" });
  }
};

/* ---------- Phase 2 sources (2026-11-14): Meta Ads, Instagram, Gmail+Calendar ---------- */
// Read-only; see services/founderSources.js. ?refresh=1 skips the 5-minute
// cache (the "Sync now" button). NOT_CONFIGURED -> 503 so the admin panel can
// show "Not connected" for that one source; any other failure -> 502 with the
// upstream message (super_admin only, and it never contains the token).
const sourceHandler = (label, fetcher) => async (req, res) => {
  try {
    res.json(await fetcher({ force: req.query.refresh === "1" }));
  } catch (error) {
    if (error?.code === "NOT_CONFIGURED") {
      return res.status(503).json({ code: "NOT_CONFIGURED", message: error.message });
    }
    console.error(`founder ${label}:`, error?.message);
    res.status(502).json({ code: "SOURCE_ERROR", message: error?.message || `Failed to load ${label}` });
  }
};

export const getFounderAds = sourceHandler("ads", fetchMetaAds);
export const getFounderInstagram = sourceHandler("instagram", fetchInstagram);
export const getFounderGoogle = sourceHandler("google", fetchGoogle);
export const getFounderWhatsApp = sourceHandler("whatsapp", fetchWhatsApp);

/* ---------- Phase 3 (2026-11-14): AI brief + Ask box (Gemini, read-only) ---------- */
// The snapshot reuses each source's 5-minute cache, so asking a question does
// not hit Meta/Google/Twilio again. A source that fails is marked unavailable.
const loadContext = async () => {
  const [sales, ads, instagram, google, whatsapp] = await Promise.allSettled([
    computeFounderSales(), fetchMetaAds(), fetchInstagram(), fetchGoogle(), fetchWhatsApp(),
  ]);
  return buildContext({ sales, ads, instagram, google, whatsapp });
};

const aiError = (res, label, error) => {
  if (error?.code === "NOT_CONFIGURED") return res.status(503).json({ code: "NOT_CONFIGURED", message: error.message });
  if (error?.code === "BAD_REQUEST") return res.status(400).json({ code: "BAD_REQUEST", message: error.message });
  if (error?.code === "RATE_LIMITED") return res.status(429).json({ code: "RATE_LIMITED", message: error.message });
  console.error(`founder ${label}:`, error?.message);
  return res.status(502).json({ code: "SOURCE_ERROR", message: error?.message || `Failed to load ${label}` });
};

export const getFounderBrief = async (req, res) => {
  try {
    res.json(await getBrief({ force: req.query.refresh === "1", loadContext }));
  } catch (error) {
    aiError(res, "brief", error);
  }
};

export const postFounderAsk = async (req, res) => {
  try {
    res.json(await ask({ question: req.body?.question, loadContext }));
  } catch (error) {
    aiError(res, "ask", error);
  }
};
