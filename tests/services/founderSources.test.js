import { jest } from '@jest/globals';

/**
 * Founder dashboard Phase 2 sources (2026-11-14). fetch is faked: no real call
 * to Meta or Google. Checks: NOT_CONFIGURED when keys are missing, read-only
 * (GET only to Meta), result picking, cache + force refresh, https-only links,
 * the Apps Script secret travels in the POST body, and the controller's
 * 503 / 502 mapping.
 */

const {
  fetchMetaAds, fetchInstagram, fetchGoogle, pickAction, safeLink, _clearFounderCache,
} = await import('../../services/founderSources.js');
const { getFounderAds, getFounderGoogle } = await import('../../controllers/Admin/founderController.js');

const ENV_KEYS = ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID', 'META_IG_USER_ID', 'FOUNDER_APPS_SCRIPT_URL', 'FOUNDER_APPS_SCRIPT_SECRET'];
const saved = {};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// Route a fake Graph API by path.
const graphRouter = (routes) => jest.fn(async (url) => {
  const u = new URL(url);
  const key = u.pathname.replace('/v21.0', '') + (u.searchParams.get('time_increment') ? '#daily' : '') + (u.searchParams.get('date_preset') ? `@${u.searchParams.get('date_preset')}` : '');
  const hit = Object.entries(routes).find(([k]) => key.startsWith(k) || key === k);
  return hit ? ok(hit[1]) : ok({ data: [] });
});

beforeEach(() => {
  ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  _clearFounderCache();
  global.fetch = jest.fn();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  console.error.mockRestore();
});

describe('helpers', () => {
  it('pickAction uses the most valuable result type present', () => {
    const actions = [{ action_type: 'link_click', value: '50' }, { action_type: 'lead', value: '7' }];
    expect(pickAction(actions, ['purchase', 'lead', 'link_click'])).toBe(7);
    expect(pickAction([], ['purchase'])).toBe(0);
  });
  it('safeLink only lets https through', () => {
    expect(safeLink('https://x.com/a')).toBe('https://x.com/a');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('http://x.com')).toBeNull();
    expect(safeLink(undefined)).toBeNull();
  });
});

describe('fetchMetaAds', () => {
  it('is NOT_CONFIGURED without a token or account', async () => {
    await expect(fetchMetaAds()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('builds campaign rows from GET-only calls, and caches', async () => {
    process.env.META_ACCESS_TOKEN = 'tok';
    process.env.META_AD_ACCOUNT_ID = '123';
    const ins = (spend, leads, value) => ({ data: [{ campaign_id: 'c1', campaign_name: 'Wash', spend: String(spend), actions: [{ action_type: 'lead', value: String(leads) }], action_values: value ? [{ action_type: 'purchase', value: String(value) }] : [] }] });
    global.fetch = graphRouter({
      '/act_123/campaigns': { data: [{ id: 'c1', name: 'Wash', effective_status: 'ACTIVE' }, { id: 'old', name: 'Old', effective_status: 'PAUSED' }] },
      '/act_123/insights#daily': { data: [5, 6, 7, 8, 9].map((d, i) => ({ campaign_id: 'c1', campaign_name: 'Wash', date_start: `2026-11-0${d}`, spend: String(100 + i * 20), actions: [{ action_type: 'lead', value: '1' }] })) },
      '/act_123/insights@last_7d': ins(700, 10, 2100),
      '/act_123/insights@last_14d': ins(1400, 20, 4000),
      '/act_123/insights@last_30d': ins(3000, 40, 9000),
    });

    const out = await fetchMetaAds();
    expect(out.campaigns).toHaveLength(1); // paused, no spend -> skipped
    const c = out.campaigns[0];
    expect(c).toMatchObject({ id: 'c1', status: 'ACTIVE', spend: { 7: 700, 14: 1400, 30: 3000 }, results: { 7: 10, 14: 20, 30: 40 } });
    expect(c.purchaseValue).toEqual({ 7: 2100, 14: 4000, 30: 9000 });
    expect(c.cprTrend).toEqual([120, 140, 160, 180]); // last 4 days, oldest first

    for (const [, opts] of global.fetch.mock.calls) expect(opts.method).toBe('GET');
    const calls = global.fetch.mock.calls.length;
    await fetchMetaAds();
    expect(global.fetch.mock.calls.length).toBe(calls); // cached
    await fetchMetaAds({ force: true });
    expect(global.fetch.mock.calls.length).toBe(calls * 2); // Sync now
  });

  it('surfaces a Meta error without the token', async () => {
    process.env.META_ACCESS_TOKEN = 'secret-token';
    process.env.META_AD_ACCOUNT_ID = 'act_9';
    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid OAuth access token.' } }) }));
    const err = await fetchMetaAds().catch((e) => e);
    expect(err.message).toBe('Meta: Invalid OAuth access token.');
    expect(err.message).not.toContain('secret-token');
  });
});

describe('fetchInstagram', () => {
  it('keeps reels only, reads views/saves, and lists recent comments', async () => {
    process.env.META_ACCESS_TOKEN = 'tok';
    process.env.META_IG_USER_ID = 'ig1';
    global.fetch = graphRouter({
      '/ig1/media': { data: [
        { id: 'r1', caption: 'Wash at home\nmore', media_product_type: 'REELS', timestamp: '2026-11-13T10:00:00Z', like_count: 9, comments_count: 2, permalink: 'https://instagram.com/r1' },
        { id: 'p1', caption: 'photo', media_product_type: 'FEED', timestamp: '2026-11-12T10:00:00Z' },
      ] },
      '/r1/insights': { data: [{ name: 'views', values: [{ value: 1500 }] }, { name: 'saved', values: [{ value: 12 }] }] },
      '/r1/comments': { data: [{ id: 'k1', text: 'Price?', username: 'amit', timestamp: '2026-11-13T11:00:00Z' }] },
    });
    const out = await fetchInstagram();
    expect(out.reels).toEqual([expect.objectContaining({ id: 'r1', caption: 'Wash at home', views: 1500, likes: 9, comments: 2, saves: 12, link: 'https://instagram.com/r1' })]);
    expect(out.comments).toEqual([expect.objectContaining({ from: '@amit', text: 'Price?', reel: 'Wash at home' })]);
  });
});

describe('fetchGoogle', () => {
  it('sends the secret in the POST body and drops non-https links', async () => {
    process.env.FOUNDER_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/x/exec';
    process.env.FOUNDER_APPS_SCRIPT_SECRET = 's3cret';
    global.fetch = jest.fn(async () => ok({
      messages: [{ id: 'g1', from: 'Razorpay', text: 'Docs needed', time: '2026-11-14T03:00:00Z', link: 'javascript:alert(1)' }],
      calendar: [{ id: 'e1', title: 'Call', start: '2026-11-14T08:00:00Z', end: '2026-11-14T08:30:00Z', link: 'https://calendar.google.com/x' }],
    }));
    const out = await fetchGoogle();
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).not.toContain('s3cret');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ secret: 's3cret' });
    expect(out.messages[0]).toMatchObject({ app: 'gmail', from: 'Razorpay', link: null });
    expect(out.calendar[0].link).toBe('https://calendar.google.com/x');
  });

  it('reports a wrong secret from the script', async () => {
    process.env.FOUNDER_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/x/exec';
    process.env.FOUNDER_APPS_SCRIPT_SECRET = 'bad';
    global.fetch = jest.fn(async () => ok({ error: 'unauthorized' }));
    await expect(fetchGoogle()).rejects.toThrow('Apps Script: unauthorized');
  });

  // 2026-11-14: YouTube + Google Ads ride on the same Apps Script response.
  const setEnv = () => {
    process.env.FOUNDER_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/x/exec';
    process.env.FOUNDER_APPS_SCRIPT_SECRET = 's';
  };

  it('returns youtube/googleAds as null when absent or malformed', async () => {
    setEnv();
    global.fetch = jest.fn(async () => ok({ messages: [], calendar: [], youtube: 'x', googleAds: { campaigns: 'nope' } }));
    const out = await fetchGoogle();
    expect(out.youtube).toBeNull();
    expect(out.googleAds).toBeNull();
    _clearFounderCache();
    global.fetch = jest.fn(async () => ok({ messages: [], calendar: [] }));
    const out2 = await fetchGoogle();
    expect(out2).toMatchObject({ youtube: null, googleAds: null });
  });

  it('cleans youtube: numbers, https-only links, 10 videos max', async () => {
    setEnv();
    const videos = Array.from({ length: 12 }, (_, i) => ({ id: `v${i}`, title: 'T'.repeat(500), views: '12', likes: 'abc', comments: null, time: '2026-11-13T00:00:00Z', link: i ? 'https://www.youtube.com/watch?v=v' + i : 'javascript:x' }));
    global.fetch = jest.fn(async () => ok({ messages: [], calendar: [], youtube: { channel: { title: 'Keplix', subscribers: '42' }, videos: [...videos, null] } }));
    const { youtube } = await fetchGoogle();
    expect(youtube.channel).toEqual({ title: 'Keplix', subscribers: 42 });
    expect(youtube.videos).toHaveLength(10);
    expect(youtube.videos[0]).toEqual({ id: 'v0', title: 'T'.repeat(200), views: 12, likes: 0, comments: 0, time: '2026-11-13T00:00:00Z', link: null });
    expect(youtube.videos[1].link).toBe('https://www.youtube.com/watch?v=v1');
  });

  it('cleans googleAds into the Meta campaign shape', async () => {
    setEnv();
    global.fetch = jest.fn(async () => ok({ messages: [], calendar: [], googleAds: {
      updatedAt: '2026-11-14T04:00:00Z',
      campaigns: [
        { id: 123, name: 'Search', status: 'ENABLED', spend: { 7: '100.5', 14: 200, 30: 'x' }, results: { 7: 2 }, purchaseValue: null, cprTrend: [1, 2, 3, 4, 5] },
        { name: 'PMax', spend: {}, results: {}, purchaseValue: { 7: 10, 14: 20, 30: 30 }, cprTrend: 'bad' },
        'junk',
      ],
    } }));
    const { googleAds } = await fetchGoogle();
    expect(googleAds.updatedAt).toBe('2026-11-14T04:00:00Z');
    expect(googleAds.campaigns).toEqual([
      { id: '123', name: 'Search', status: 'ENABLED', spend: { 7: 100.5, 14: 200, 30: 0 }, results: { 7: 2, 14: 0, 30: 0 }, purchaseValue: null, cprTrend: [2, 3, 4, 5] },
      { id: 'ga1', name: 'PMax', status: 'UNKNOWN', spend: { 7: 0, 14: 0, 30: 0 }, results: { 7: 0, 14: 0, 30: 0 }, purchaseValue: { 7: 10, 14: 20, 30: 30 }, cprTrend: [] },
    ]);
  });
});

describe('controller mapping', () => {
  const res = () => { const r = { status: jest.fn(), json: jest.fn() }; r.status.mockReturnValue(r); return r; };

  it('NOT_CONFIGURED -> 503', async () => {
    const r = res();
    await getFounderAds({ query: {} }, r);
    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
  });

  it('upstream failure -> 502 with the message', async () => {
    process.env.FOUNDER_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/x/exec';
    process.env.FOUNDER_APPS_SCRIPT_SECRET = 'x';
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const r = res();
    await getFounderGoogle({ query: { refresh: '1' } }, r);
    expect(r.status).toHaveBeenCalledWith(502);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SOURCE_ERROR', message: 'Apps Script: HTTP 500' }));
  });
});
