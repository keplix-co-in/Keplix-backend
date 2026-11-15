import { jest } from '@jest/globals';

/**
 * Founder dashboard Phase 3 (2026-11-14): WhatsApp via Twilio's read-only list,
 * and the Gemini brief / Ask box. fetch is faked: nothing reaches Twilio or
 * Google. Checks: NOT_CONFIGURED without keys, GET-only + inbound-only +
 * masked numbers for WhatsApp, key in a header (not the URL) for Gemini,
 * brief caching and the once-a-minute force limit, Ask validation and
 * hourly limit, and the controller's status mapping.
 */

const { fetchWhatsApp, maskPhone, _clearFounderCache } = await import('../../services/founderSources.js');
const { getBrief, ask, buildContext, _resetFounderAI, MAX_QUESTION } = await import('../../services/founderAI.js');
const { postFounderAsk } = await import('../../controllers/Admin/founderController.js');

const ENV_KEYS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_WHATSAPP_FROM', 'GEMINI_API_KEY'];
const saved = {};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const geminiOk = (text) => ok({ candidates: [{ content: { parts: [{ text }] } }] });
const ctx = jest.fn(async () => ({ sales: 'unavailable' }));

beforeEach(() => {
  ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  _clearFounderCache();
  _resetFounderAI();
  ctx.mockClear();
  global.fetch = jest.fn();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  console.error.mockRestore();
  jest.useRealTimers();
});

describe('fetchWhatsApp', () => {
  it('is NOT_CONFIGURED without Twilio values', async () => {
    await expect(fetchWhatsApp()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('GETs inbound messages to our number, masks senders, and caches', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC1';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';
    global.fetch = jest.fn(async () => ok({ messages: [
      { sid: 'SM1', direction: 'inbound', from: 'whatsapp:+919876543210', body: 'Is my car ready?', date_sent: 'Fri, 14 Nov 2026 09:30:00 +0000' },
      { sid: 'SM2', direction: 'outbound-api', from: 'whatsapp:+14155238886', body: 'Your OTP is 1234' },
      { sid: 'SM3', direction: 'inbound', from: 'whatsapp:+919000000001', body: '' },
    ] }));

    const out = await fetchWhatsApp();
    const [url, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe('GET');
    expect(String(url)).not.toContain('tok');
    expect(new URL(url).searchParams.get('To')).toBe('whatsapp:+14155238886'); // prefix not doubled
    expect(opts.headers.Authorization).toBe(`Basic ${Buffer.from('AC1:tok').toString('base64')}`);
    expect(out.messages).toEqual([
      { id: 'SM1', app: 'whatsapp', from: '+91 ••••• 3210', text: 'Is my car ready?', time: '2026-11-14T09:30:00.000Z', link: null },
      expect.objectContaining({ id: 'SM3', text: '(media message)' }),
    ]);
    await fetchWhatsApp();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('prefers the API key pair when set', async () => {
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_API_KEY_SID: 'SK1', TWILIO_API_KEY_SECRET: 'sec', TWILIO_WHATSAPP_FROM: '+1415' });
    global.fetch = jest.fn(async () => ok({ messages: [] }));
    await fetchWhatsApp();
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('SK1:sec').toString('base64')}`);
  });

  it('maskPhone keeps only the country code and last 4 digits', () => {
    expect(maskPhone('whatsapp:+919876543210')).toBe('+91 ••••• 3210');
    expect(maskPhone('')).toBe('Unknown');
  });
});

describe('buildContext', () => {
  it('marks failed sources unavailable instead of dropping them', () => {
    const c = buildContext({
      sales: { status: 'fulfilled', value: { today: { amount: 1 }, yesterday: {}, sameDayLastWeek: {}, chart: [{ date: '2026-11-14', amount: 10.4 }], failed: [1], refunds: [] } },
      ads: { status: 'rejected', reason: new Error('x') },
      instagram: { status: 'rejected' },
      google: { status: 'rejected' },
      whatsapp: { status: 'fulfilled', value: { messages: [{ text: 'hi', time: 't', from: '+91 ••••• 1' }] } },
    });
    expect(c.sales).toMatchObject({ last14Days: [['2026-11-14', 10]], failedPayments: 1 });
    expect(c.ads).toBe('unavailable');
    expect(c.whatsapp).toEqual([{ text: 'hi', time: 't' }]); // no phone number sent to Gemini
  });

  it('hides emails and typed phone numbers before they reach Gemini', () => {
    const c = buildContext({
      google: { status: 'fulfilled', value: { messages: [{ from: 'a@b.com', text: 'from x@y.in' }], calendar: [] } },
      whatsapp: { status: 'fulfilled', value: { messages: [{ text: 'call me on 98765 43210', time: 't' }] } },
    });
    expect(c.unreadEmail).toEqual([{ from: '[email]', subject: 'from [email]' }]);
    expect(c.whatsapp[0].text).toBe('call me on [number]');
  });

  it('scrubs numbers in email subjects, IG comments and meeting titles (review 2026-11-14)', () => {
    const c = buildContext({
      google: { status: 'fulfilled', value: { messages: [{ from: 'Ravi 9876543210', text: 'Booking 98765 43210' }], calendar: [{ title: 'Call 9876543210', start: 's' }] } },
      instagram: { status: 'fulfilled', value: { reels: [], comments: [{ text: 'mail x@y.com or 9876543210' }] } },
    });
    expect(c.unreadEmail).toEqual([{ from: 'Ravi [number]', subject: 'Booking [number]' }]);
    expect(c.meetingsNext7Days[0].title).toBe('Call [number]');
    expect(c.instagram.newComments).toEqual(['mail [email] or [number]']);
  });

  // 2026-11-14: YouTube + Google Ads in the AI snapshot, without links.
  it('adds youtube and googleAds, or "unavailable" when null', () => {
    const chart = Array.from({ length: 60 }, (_, i) => ({ date: `d${i}`, amount: i }));
    const c = buildContext({
      sales: { status: 'fulfilled', value: { chart, failed: [], refunds: [] } },
      google: { status: 'fulfilled', value: { messages: [], calendar: [],
        youtube: { channel: { title: 'Keplix', subscribers: 5 }, videos: [{ id: 'v', title: 'Oil change', views: 9, likes: 1, comments: 0, time: 't', link: 'https://y/v' }] },
        googleAds: { campaigns: [{ id: '1', name: 'Search', status: 'ENABLED', spend: { 7: 50 }, results: { 7: 2 }, cprTrend: [25] }], updatedAt: 'u' } } },
    });
    expect(c.sales.last14Days).toHaveLength(14);
    expect(c.youtube).toEqual({ channel: 'Keplix', subscribers: 5, videos: [{ title: 'Oil change', views: 9, likes: 1, comments: 0, time: 't' }] });
    expect(c.googleAds).toEqual([{ name: 'Search', status: 'ENABLED', spend7d: 50, results7d: 2, costPerResultLast4Days: [25] }]);
    const none = buildContext({ google: { status: 'fulfilled', value: { messages: [], calendar: [], youtube: null, googleAds: null } } });
    expect(none.youtube).toBe('unavailable');
    expect(none.googleAds).toBe('unavailable');
    expect(buildContext({}).googleAds).toBe('unavailable');
  });
});

describe('getBrief', () => {
  it('is NOT_CONFIGURED without GEMINI_API_KEY and loads nothing', async () => {
    await expect(getBrief({ loadContext: ctx })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(ctx).not.toHaveBeenCalled();
  });

  it('sends the key in a header, caches, and limits forced refreshes to once a minute', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-14T03:00:00Z') });
    process.env.GEMINI_API_KEY = 'gkey';
    global.fetch = jest.fn(async () => geminiOk('- Sales up\nDo first: reply Razorpay'));

    const first = await getBrief({ loadContext: ctx });
    expect(first.text).toContain('Do first');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).not.toContain('gkey');
    expect(opts.headers['x-goog-api-key']).toBe('gkey');

    await getBrief({ force: true, loadContext: ctx }); // within a minute -> cached
    expect(global.fetch).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date('2026-11-14T03:02:00Z'));
    await getBrief({ loadContext: ctx }); // not forced, under an hour -> cached
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await getBrief({ force: true, loadContext: ctx });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('maps a Gemini 429 to RATE_LIMITED', async () => {
    process.env.GEMINI_API_KEY = 'gkey';
    global.fetch = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(getBrief({ loadContext: ctx })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('ask', () => {
  it('rejects empty and too-long questions before calling Gemini', async () => {
    process.env.GEMINI_API_KEY = 'gkey';
    await expect(ask({ question: '  ', loadContext: ctx })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(ask({ question: 'x'.repeat(MAX_QUESTION + 1), loadContext: ctx })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('answers, then stops after 20 questions an hour', async () => {
    process.env.GEMINI_API_KEY = 'gkey';
    global.fetch = jest.fn(async () => geminiOk('Sales were ₹0.'));
    const r = await ask({ question: 'How were sales?', loadContext: ctx });
    expect(r.answer).toBe('Sales were ₹0.');
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).contents[0].parts[0].text).toContain('Question: How were sales?');
    for (let i = 0; i < 19; i++) await ask({ question: 'q', loadContext: ctx });
    await expect(ask({ question: 'q', loadContext: ctx })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('cut-off answers are an error and failed calls do not use up the limit', async () => {
    process.env.GEMINI_API_KEY = 'gkey';
    global.fetch = jest.fn(async () => ok({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }));
    for (let i = 0; i < 25; i++) await expect(ask({ question: 'q', loadContext: ctx })).rejects.toThrow(/cut off/);
    global.fetch = jest.fn(async () => geminiOk('ok'));
    await expect(ask({ question: 'q', loadContext: ctx })).resolves.toMatchObject({ answer: 'ok' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});

describe('postFounderAsk mapping', () => {
  const res = () => { const r = { status: jest.fn(), json: jest.fn() }; r.status.mockReturnValue(r); return r; };
  it('400 for a bad question, 503 without a key', async () => {
    process.env.GEMINI_API_KEY = 'gkey';
    let r = res();
    await postFounderAsk({ body: {} }, r);
    expect(r.status).toHaveBeenCalledWith(400);
    delete process.env.GEMINI_API_KEY;
    r = res();
    await postFounderAsk({ body: { question: 'hi' } }, r);
    expect(r.status).toHaveBeenCalledWith(503);
  });
});
