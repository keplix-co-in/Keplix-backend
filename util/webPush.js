import webpush from 'web-push';
import prisma from './prisma.js';
import Logger from './logger.js';

/**
 * Web Push for the vendor portal (browser alerts that arrive with the tab or
 * even the browser closed). The mobile apps use Expo push instead
 * (util/notificationHelper.js); this sits beside it, not in place of it.
 *
 * Needs a VAPID key pair (`npx web-push generate-vapid-keys`). Without
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY the feature is simply off: nothing is
 * sent, nothing throws, and the rest of notification delivery is unaffected —
 * the same graceful degradation Twilio has.
 */

// Push services a browser can hand out an endpoint for. The server POSTs to
// whatever endpoint a vendor registers, so accepting any URL would let a signed-in
// user aim this server at an internal address (SSRF). Only these hosts are valid.
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com', // Chrome, Edge, Brave, Opera on Chromium
  'push.services.mozilla.com', // Firefox
  'notify.windows.com', // legacy Edge / Windows
  'push.apple.com', // Safari (web.push.apple.com)
];

export const isAllowedPushEndpoint = (endpoint) => {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

let warnedUnconfigured = false;
let configuredFor = null;

/** True when VAPID keys are present; sets them on the library the first time. */
export const isWebPushConfigured = () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      Logger.warn('[webPush] VAPID keys are not set — browser push alerts are disabled');
    }
    return false;
  }
  if (configuredFor !== publicKey) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:info@keplix.co.in',
      publicKey,
      privateKey
    );
    configuredFor = publicKey;
  }
  return true;
};

/** Where clicking the notification should go, from the notification's own data. */
const targetUrl = (metadata = {}) => {
  const bookingId = metadata.bookingId ?? metadata.data?.bookingId;
  return bookingId ? `/bookings/${bookingId}` : '/notifications';
};

/**
 * Sends one notification to every browser this user has subscribed.
 * Never throws — a push failure must not affect the booking or payment that
 * triggered it, matching createNotification's own contract.
 *
 * @param {number} userId
 * @param {{title: string, message?: string, metadata?: object}} notification
 */
export const sendWebPushToUser = async (userId, { title, message, metadata = {} }) => {
  try {
    if (!isWebPushConfigured()) return;

    const subscriptions = await prisma.webPushSubscription.findMany({ where: { userId } });
    if (!subscriptions.length) return;

    const type = metadata.type ?? 'NOTIFICATION';
    const urgent = type === 'NEW_BOOKING_ALERT';
    const payload = JSON.stringify({
      title,
      body: message ?? '',
      // The portal's own desktop notification uses the same tag, so a vendor
      // with both on sees one alert, not two.
      tag: `kx-${type}`,
      url: targetUrl(metadata),
      urgent,
    });
    // A new-request alert is only actionable for the booking timeout window
    // (5 min by default), so a push older than that is worse than none.
    const options = urgent ? { TTL: 300, urgency: 'high' } : { TTL: 3600, urgency: 'normal' };

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            options
          );
        } catch (error) {
          // 404/410: the browser unsubscribed or the subscription expired. Keep
          // the table clean so we stop trying it.
          if (error?.statusCode === 404 || error?.statusCode === 410) {
            await prisma.webPushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
            return;
          }
          Logger.error(
            `[webPush] send failed for user ${userId} (status ${error?.statusCode ?? 'n/a'}): ${error?.message}`
          );
        }
      })
    );
  } catch (error) {
    Logger.error(`[webPush] unexpected failure for user ${userId}:`, error);
  }
};
