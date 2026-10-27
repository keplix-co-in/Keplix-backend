import { jest } from '@jest/globals';

/**
 * util/blogPublishHooks.js — website rebuild + IndexNow after a blog change.
 *
 * What must hold:
 *  - a draft that stays a draft touches nothing public: no requests at all;
 *  - publishing, editing a live post, unpublishing, re-slugging and deleting
 *    report the right public URLs (old and new), plus /blog;
 *  - the deploy hook only fires for an https api.vercel.com URL;
 *  - IndexNow is only pinged in production;
 *  - a failing or rejecting endpoint never throws into the admin save.
 */

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../util/logger.js', () => ({ default: mockLogger }));

const { affectedBlogUrls, isVercelDeployHook, onBlogPostChanged, INDEXNOW_KEY } = await import(
  '../../util/blogPublishHooks.js'
);

const HOOK = 'https://api.vercel.com/v1/integrations/deploy/prj_x/abc';
const live = (slug) => ({ slug, status: 'published' });
const draft = (slug) => ({ slug, status: 'draft' });

const ORIGINAL_ENV = { ...process.env };
let fetchMock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, NODE_ENV: 'production', VERCEL_DEPLOY_HOOK_URL: HOOK };
  delete process.env.PUBLIC_WEB_BASE_URL;
  fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  global.fetch = fetchMock;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('affectedBlogUrls', () => {
  test('draft edited and still draft -> nothing', () => {
    expect(affectedBlogUrls(draft('a'), draft('a'))).toEqual([]);
    expect(affectedBlogUrls(null, draft('a'))).toEqual([]);
  });

  test('publish -> the post and /blog', () => {
    expect(affectedBlogUrls(draft('a'), live('a'))).toEqual([
      'https://keplix.co.in/blog/a',
      'https://keplix.co.in/blog',
    ]);
  });

  test('re-slug of a live post -> old and new URL', () => {
    expect(affectedBlogUrls(live('old'), live('new'))).toEqual([
      'https://keplix.co.in/blog/old',
      'https://keplix.co.in/blog/new',
      'https://keplix.co.in/blog',
    ]);
  });

  test('unpublish and delete -> the old URL', () => {
    expect(affectedBlogUrls(live('a'), draft('a'))).toContain('https://keplix.co.in/blog/a');
    expect(affectedBlogUrls(live('a'), null)).toContain('https://keplix.co.in/blog/a');
  });

  test('uses PUBLIC_WEB_BASE_URL without a trailing slash', () => {
    process.env.PUBLIC_WEB_BASE_URL = 'https://example.in/';
    expect(affectedBlogUrls(null, live('a'))[0]).toBe('https://example.in/blog/a');
  });
});

describe('isVercelDeployHook', () => {
  test.each([
    [HOOK, true],
    ['http://api.vercel.com/x', false],
    ['https://api.vercel.com.evil.io/x', false],
    ['https://169.254.169.254/latest', false],
    ['not a url', false],
  ])('%s -> %s', (url, ok) => expect(isVercelDeployHook(url)).toBe(ok));
});

describe('onBlogPostChanged', () => {
  test('draft-only change makes no requests', async () => {
    await onBlogPostChanged(draft('a'), draft('a'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('publish triggers the deploy hook and an IndexNow ping', async () => {
    await onBlogPostChanged(draft('a'), live('a'));
    const urls = fetchMock.mock.calls.map(([u]) => u);
    expect(urls).toEqual(expect.arrayContaining([HOOK, 'https://api.indexnow.org/indexnow']));

    const [, init] = fetchMock.mock.calls.find(([u]) => u.includes('indexnow'));
    expect(JSON.parse(init.body)).toEqual({
      host: 'keplix.co.in',
      key: INDEXNOW_KEY,
      keyLocation: `https://keplix.co.in/${INDEXNOW_KEY}.txt`,
      urlList: ['https://keplix.co.in/blog/a', 'https://keplix.co.in/blog'],
    });
  });

  test('no IndexNow outside production; no rebuild without a hook', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.VERCEL_DEPLOY_HOOK_URL;
    await onBlogPostChanged(null, live('a'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a non-Vercel hook URL is refused', async () => {
    process.env.NODE_ENV = 'development';
    process.env.VERCEL_DEPLOY_HOOK_URL = 'https://attacker.example/hook';
    await onBlogPostChanged(null, live('a'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('failures are logged, never thrown', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 }).mockRejectedValueOnce(new Error('timeout'));
    await expect(onBlogPostChanged(null, live('a'))).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });
});
