/**
 * Founder dashboard Phase 2 sources (2026-11-14, owner request). READ-ONLY.
 *
 * Every call here is an HTTP GET to Meta's Graph API, or a POST to the owner's
 * own Google Apps Script that only reads Gmail/Calendar. Nothing here pauses an
 * ad, changes a budget, replies to a comment or sends an email -- the owner
 * asked for a dashboard that can never act on their accounts. Keep it that way:
 * if a future feature needs a write, it does not belong in this file.
 *
 * Config (Cloud Run secrets / .env; never commit values):
 *   META_ACCESS_TOKEN     long-lived token with ads_read, instagram_basic,
 *                         instagram_manage_insights, pages_read_engagement
 *   META_AD_ACCOUNT_ID    "act_123..." or just the digits
 *   META_IG_USER_ID       Instagram business account id
 *   FOUNDER_APPS_SCRIPT_URL / FOUNDER_APPS_SCRIPT_SECRET
 *                         see scripts/founder-apps-script.gs
 * A missing value makes that source answer NOT_CONFIGURED (the admin panel
 * shows "Not connected") instead of failing the whole dashboard.
 *
 * Results are cached in memory for 5 minutes. The backend is single-instance
 * (min=max=1, see CLAUDE.md), so an in-process cache is enough and keeps us
 * far below Meta's rate limits however often the page is refreshed.
 */

const GRAPH = "https://graph.facebook.com/v21.0";
const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15000;

export class NotConfiguredError extends Error {
  constructor(what) {
    super(`${what} is not set up yet`);
    this.code = "NOT_CONFIGURED";
  }
}

const cache = new Map();
export const _clearFounderCache = () => cache.clear();

const cached = async (key, force, fn) => {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
};

const n = (v) => Number(v ?? 0) || 0;
const str = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
// Links from outside sources are rendered as <a href>; only https survives, so
// a javascript: or data: URL can never reach the page (review note 2026-11-14).
export const safeLink = (v) => (typeof v === "string" && /^https:\/\//i.test(v) ? v : null);

async function graph(path, params, token) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  // Meta's error text never echoes the token; the URL (which holds it) is
  // deliberately not included in the message or logged.
  if (!res.ok) throw new Error(`Meta: ${body?.error?.message || `HTTP ${res.status}`}`);
  return body;
}

/* ---------------- Meta Ads ---------------- */

// What counts as a "result", most valuable first: the first type a campaign
// actually has is used, so a sales campaign reports purchases and a lead
// campaign reports leads.
const RESULT_TYPES = [
  "purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase",
  "lead", "onsite_conversion.lead_grouped",
  "onsite_conversion.messaging_conversation_started_7d",
  "link_click",
];
const VALUE_TYPES = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"];

export const pickAction = (list, types) => {
  for (const t of types) {
    const hit = (list || []).find((a) => a.action_type === t);
    if (hit) return n(hit.value);
  }
  return 0;
};

export async function fetchMetaAds({ force = false } = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  const rawAcct = process.env.META_AD_ACCOUNT_ID;
  if (!token || !rawAcct) throw new NotConfiguredError("Meta Ads");
  const act = rawAcct.startsWith("act_") ? rawAcct : `act_${rawAcct}`;

  return cached("meta_ads", force, async () => {
    const fields = "campaign_id,campaign_name,spend,actions,action_values";
    const insight = (date_preset, extra = {}) =>
      graph(`/${act}/insights`, { level: "campaign", date_preset, fields, limit: 200, ...extra }, token);

    const [campaigns, d7, d14, d30, daily] = await Promise.all([
      graph(`/${act}/campaigns`, { fields: "id,name,effective_status", limit: 200 }, token),
      insight("last_7d"),
      insight("last_14d"),
      insight("last_30d"),
      insight("last_7d", { time_increment: 1 }),
    ]);

    const rows = new Map();
    const row = (id, name) => {
      if (!rows.has(id)) {
        rows.set(id, { id, name, status: "UNKNOWN", spend: { 7: 0, 14: 0, 30: 0 }, results: { 7: 0, 14: 0, 30: 0 }, value: { 7: 0, 14: 0, 30: 0 }, days: [] });
      }
      return rows.get(id);
    };
    for (const c of campaigns.data || []) row(c.id, c.name).status = c.effective_status;
    for (const [days, set] of [[7, d7], [14, d14], [30, d30]]) {
      for (const i of set.data || []) {
        const r = row(i.campaign_id, i.campaign_name);
        r.spend[days] = n(i.spend);
        r.results[days] = pickAction(i.actions, RESULT_TYPES);
        r.value[days] = pickAction(i.action_values, VALUE_TYPES);
      }
    }
    for (const i of daily.data || []) {
      const r = row(i.campaign_id, i.campaign_name);
      const results = pickAction(i.actions, RESULT_TYPES);
      r.days.push({ date: i.date_start, cpr: results ? n(i.spend) / results : 0 });
    }

    const out = [...rows.values()]
      // Skip old campaigns that spent nothing this month and are not running.
      .filter((r) => r.status === "ACTIVE" || r.spend[30] > 0)
      .map((r) => ({
        id: r.id,
        name: str(r.name, 120),
        status: r.status,
        spend: r.spend,
        results: r.results,
        purchaseValue: r.value[30] > 0 ? r.value : null,
        cprTrend: r.days.sort((a, b) => a.date.localeCompare(b.date)).slice(-4).map((d) => Math.round(d.cpr)),
      }));
    return { campaigns: out, fetchedAt: new Date().toISOString() };
  });
}

/* ---------------- Instagram ---------------- */

const insightValue = (ins, metric) => {
  const m = (ins?.data || []).find((d) => d.name === metric);
  return n(m?.total_value?.value ?? m?.values?.[0]?.value);
};

export async function fetchInstagram({ force = false } = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  const ig = process.env.META_IG_USER_ID;
  if (!token || !ig) throw new NotConfiguredError("Instagram");

  return cached("instagram", force, async () => {
    const media = await graph(`/${ig}/media`, {
      fields: "id,caption,media_product_type,timestamp,like_count,comments_count,permalink",
      limit: 30,
    }, token);
    const reels = (media.data || []).filter((m) => m.media_product_type === "REELS").slice(0, 10);

    // One insights call per reel; a reel whose insights fail still shows with
    // its likes/comments rather than dropping the whole screen.
    const insights = await Promise.allSettled(
      reels.map((r) => graph(`/${r.id}/insights`, { metric: "views,saved" }, token)),
    );
    // Comments on the 3 newest reels are enough for "waiting for a reply".
    const commentSets = await Promise.allSettled(
      reels.slice(0, 3).map((r) => graph(`/${r.id}/comments`, { fields: "id,text,username,timestamp", limit: 10 }, token)),
    );

    const caption = (r) => str((r.caption || "").split("\n")[0], 80) || "(no caption)";
    const reelRows = reels.map((r, i) => {
      const ins = insights[i].status === "fulfilled" ? insights[i].value : null;
      return {
        id: r.id,
        caption: caption(r),
        views: insightValue(ins, "views"),
        likes: n(r.like_count),
        comments: n(r.comments_count),
        saves: insightValue(ins, "saved"),
        time: r.timestamp,
        link: safeLink(r.permalink),
      };
    });
    const comments = commentSets
      .flatMap((s, i) => (s.status === "fulfilled" ? (s.value.data || []).map((c) => ({
        id: c.id,
        from: `@${str(c.username, 60)}`,
        text: str(c.text, 300),
        reel: caption(reels[i]),
        time: c.timestamp,
        link: safeLink(reels[i].permalink),
      })) : []))
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 10);

    return { reels: reelRows, comments, fetchedAt: new Date().toISOString() };
  });
}

/* ---------------- Google (Gmail + Calendar via Apps Script) ---------------- */

export async function fetchGoogle({ force = false } = {}) {
  const url = process.env.FOUNDER_APPS_SCRIPT_URL;
  const secret = process.env.FOUNDER_APPS_SCRIPT_SECRET;
  if (!url || !secret) throw new NotConfiguredError("Gmail + Calendar");
  if (!safeLink(url)) throw new Error("FOUNDER_APPS_SCRIPT_URL must be an https URL");

  return cached("google", force, async () => {
    // POST so the secret travels in the body, not the URL (URLs end up in logs).
    // Apps Script answers a POST with a 302 to the result; fetch follows it.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new Error(`Apps Script: HTTP ${res.status}`);
    if (body.error) throw new Error(`Apps Script: ${str(body.error, 120)}`);

    const messages = (Array.isArray(body.messages) ? body.messages : []).slice(0, 30).map((m, i) => ({
      id: str(m.id, 80) || `g${i}`,
      app: "gmail",
      from: str(m.from, 120),
      text: str(m.text, 300),
      time: m.time,
      link: safeLink(m.link),
    }));
    const calendar = (Array.isArray(body.calendar) ? body.calendar : []).slice(0, 50).map((e, i) => ({
      id: str(e.id, 200) || `e${i}`,
      title: str(e.title, 200) || "(no title)",
      start: e.start,
      end: e.end,
      link: safeLink(e.link),
    }));
    // youtube + googleAds (2026-11-14) come from the same owner script; they
    // are optional, so anything absent or malformed becomes null rather than
    // failing Gmail/Calendar.
    return { messages, calendar, youtube: cleanYouTube(body.youtube), googleAds: cleanGoogleAds(body.googleAds), fetchedAt: new Date().toISOString() };
  });
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const periods = (o) => ({ 7: n(o?.[7]), 14: n(o?.[14]), 30: n(o?.[30]) });

export const cleanYouTube = (y) => {
  if (!isObj(y) || !isObj(y.channel)) return null;
  return {
    channel: { title: str(y.channel.title, 120), subscribers: n(y.channel.subscribers) },
    videos: (Array.isArray(y.videos) ? y.videos : []).filter(isObj).slice(0, 10).map((v, i) => ({
      id: str(v.id, 40) || `y${i}`,
      title: str(v.title, 200) || "(no title)",
      views: n(v.views),
      likes: n(v.likes),
      comments: n(v.comments),
      time: str(v.time, 40) || null,
      link: safeLink(v.link),
    })),
  };
};

// Same campaign shape as fetchMetaAds, so the admin panel reuses one view.
export const cleanGoogleAds = (g) => {
  if (!isObj(g) || !Array.isArray(g.campaigns)) return null;
  return {
    campaigns: g.campaigns.filter(isObj).slice(0, 50).map((c, i) => ({
      id: str(String(c.id ?? ""), 40) || `ga${i}`,
      name: str(c.name, 120) || "(no name)",
      status: str(c.status, 30) || "UNKNOWN",
      spend: periods(c.spend),
      results: periods(c.results),
      purchaseValue: isObj(c.purchaseValue) ? periods(c.purchaseValue) : null,
      cprTrend: (Array.isArray(c.cprTrend) ? c.cprTrend : []).slice(-4).map(n),
    })),
    updatedAt: str(g.updatedAt, 40) || null,
  };
};

/* ---------------- WhatsApp (Phase 3, 2026-11-14) ---------------- */
// Reads the messages customers sent to our Twilio WhatsApp number, using
// Twilio's Messages LIST call (a GET). It reuses the TWILIO_* secrets the
// backend already has for sending, so there is nothing new to set up. It
// never sends or replies: sending stays in util/communication.js.

const TWILIO_API = "https://api.twilio.com/2010-04-01";

// Twilio's date_sent is RFC 2822 ("Fri, 14 Nov 2026 09:30:00 +0000").
const toIso = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// "whatsapp:+9198..." -> "+91 ••••• 4321": the full number is not needed to
// see who wrote, and a masked one is safer on a screen someone may glance at.
export const maskPhone = (v) => {
  const digits = String(v || "").replace(/^whatsapp:/, "").replace(/[^\d+]/g, "");
  if (digits.length < 6) return digits || "Unknown";
  return `${digits.slice(0, 3)} ••••• ${digits.slice(-4)}`;
};

export async function fetchWhatsApp({ force = false } = {}) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const keyPair = process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET;
  const user = keyPair ? process.env.TWILIO_API_KEY_SID : sid;
  const pass = keyPair ? process.env.TWILIO_API_KEY_SECRET : process.env.TWILIO_AUTH_TOKEN;
  // .env.example writes the number with the whatsapp: prefix and the sender
  // adds one too, so accept both forms.
  const number = String(process.env.TWILIO_WHATSAPP_FROM || "").replace(/^whatsapp:/, "");
  if (!sid || !pass || !number) throw new NotConfiguredError("WhatsApp (Twilio)");

  return cached("whatsapp", force, async () => {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = new URL(`${TWILIO_API}/Accounts/${encodeURIComponent(sid)}/Messages.json`);
    url.searchParams.set("To", `whatsapp:${number}`);
    url.searchParams.set("DateSent>", since);
    url.searchParams.set("PageSize", "50");
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    // Twilio's error text never contains the auth token.
    if (!res.ok) throw new Error(`Twilio: ${str(body?.message, 120) || `HTTP ${res.status}`}`);

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m.direction === "inbound")
      .slice(0, 30)
      .map((m, i) => ({
        id: str(m.sid, 64) || `w${i}`,
        app: "whatsapp",
        from: maskPhone(m.from),
        text: str(m.body, 300) || "(media message)",
        time: toIso(m.date_sent || m.date_created),
        link: null, // Twilio has no per-message page the owner can reply from.
      }));
    return { messages, fetchedAt: new Date().toISOString() };
  });
}
