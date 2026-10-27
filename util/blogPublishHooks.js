import logger from "./logger.js";

/**
 * Side effects of a blog post going live, changing, or going away.
 *
 * keplix.co.in is prerendered at build time (keplix-website/scripts/prerender.mjs):
 * the sitemap, llms.txt and the crawlable HTML for every post only change when
 * the site is rebuilt. Before this, publishing a post in the admin panel did
 * nothing until someone remembered to redeploy the website by hand, and search
 * engines found out whenever they next happened to crawl the sitemap.
 *
 * 1. Vercel deploy hook -- rebuilds the website so the post is in the sitemap
 *    and prerendered. Off unless VERCEL_DEPLOY_HOOK_URL is set (a secret: anyone
 *    holding the URL can trigger builds, so it lives in GitHub secrets only).
 * 2. IndexNow -- tells Bing, Yandex and other IndexNow engines the URL changed.
 *    Google does not use IndexNow; it reads the sitemap. Production only, so
 *    local and test runs never ping real search engines.
 *
 * Neither may ever fail an admin save: errors are logged and swallowed. Both are
 * awaited (with a short timeout) rather than fired after the response, because
 * Cloud Run may throttle CPU once the response is sent and drop the request.
 */

// The IndexNow key is public by design: engines verify it by fetching
// https://keplix.co.in/<key>.txt, which is keplix-website/public/<key>.txt.
// Changing it means changing that file too.
export const INDEXNOW_KEY = "fdafde1ba405e7a9b54c03bd72ed932f";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const TIMEOUT_MS = 5000;

const siteBase = () =>
  (process.env.PUBLIC_WEB_BASE_URL || "https://keplix.co.in").replace(/\/+$/, "");

/**
 * Only Vercel's own hook endpoint is accepted. The server POSTs to this URL, so
 * a mistyped or tampered secret must not turn it into a request to anywhere.
 */
export const isVercelDeployHook = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "api.vercel.com";
  } catch {
    return false;
  }
};

/**
 * The public URLs touched by a change, or [] when the change is invisible to
 * the public site (a draft edited and still a draft).
 *
 * `before` is null for a newly created post, `after` is null for a deleted one.
 * An unpublished or re-slugged post's OLD url is included too, so engines
 * recrawl it and drop it instead of waiting to stumble on it.
 */
export const affectedBlogUrls = (before, after) => {
  const live = (p) => p?.status === "published" && p.slug;
  const base = siteBase();
  const urls = new Set();
  if (live(before)) urls.add(`${base}/blog/${before.slug}`);
  if (live(after)) urls.add(`${base}/blog/${after.slug}`);
  // The listing page shows every post, so it changes whenever one does.
  if (urls.size) urls.add(`${base}/blog`);
  return [...urls];
};

const post = (url, init) =>
  fetch(url, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });

async function triggerRebuild() {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) return;
  if (!isVercelDeployHook(hook)) {
    logger.warn("VERCEL_DEPLOY_HOOK_URL is not an api.vercel.com https URL; website rebuild skipped");
    return;
  }
  const res = await post(hook);
  if (!res.ok) throw new Error(`deploy hook returned ${res.status}`);
  logger.info("Website rebuild triggered after blog change");
}

async function pingIndexNow(urls) {
  if (process.env.NODE_ENV !== "production") return;
  const base = siteBase();
  const res = await post(INDEXNOW_ENDPOINT, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(base).hostname,
      key: INDEXNOW_KEY,
      keyLocation: `${base}/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    }),
  });
  // 200 and 202 both mean accepted; 202 = key not verified yet (first ping).
  if (!res.ok) throw new Error(`IndexNow returned ${res.status}`);
  logger.info(`IndexNow pinged for ${urls.length} URL(s)`);
}

/** Never throws. Resolves once both side effects have finished or failed. */
export async function onBlogPostChanged(before, after) {
  const urls = affectedBlogUrls(before, after);
  if (!urls.length) return;

  const results = await Promise.allSettled([triggerRebuild(), pingIndexNow(urls)]);
  for (const r of results) {
    if (r.status === "rejected") logger.warn(`Blog publish hook failed: ${r.reason?.message ?? r.reason}`);
  }
}
