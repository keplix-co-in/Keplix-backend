import prisma from "../util/prisma.js";
import { Expo } from 'expo-server-sdk';
import Logger from './logger.js';
import { sendWebPushToUser } from './webPush.js';


const expo = new Expo();

/**
 * Normalise the two call shapes this helper is invoked with.
 *
 * The signature is positional -- (userId, title, message, metadata) -- but four
 * call sites in util/bookingStatusManager.js pass a single object instead:
 *
 *   createNotification({ userId, title, message, type, data })
 *
 * Those calls have never worked. `userId` received an object, `title` and
 * `message` were undefined, prisma.notification.create rejected, and the catch
 * at the bottom swallowed it -- so "Booking Request Declined", "Booking Request
 * Expired", "Service Started" and "Service Time Arrived" were silently never
 * delivered to anyone.
 *
 * Rather than only fixing those four sites and leaving the same trap set for
 * the next caller, both shapes are accepted. The object form is arguably the
 * nicer API, so it is now legitimate rather than a bug.
 */
const normaliseArgs = (userIdOrPayload, title, message, metadata) => {
  const isPayloadObject =
    userIdOrPayload !== null &&
    typeof userIdOrPayload === 'object' &&
    !Array.isArray(userIdOrPayload);

  if (!isPayloadObject) {
    return {
      userId: userIdOrPayload,
      title,
      message,
      metadata: metadata || {},
    };
  }

  const p = userIdOrPayload;
  return {
    userId: p.userId,
    title: p.title,
    message: p.message ?? p.body,
    // `type` and `data` are first-class in the object form; anything else the
    // caller passed is preserved so no metadata is silently dropped.
    metadata: {
      ...(p.metadata || {}),
      ...(p.data ? { data: p.data } : {}),
      ...(p.type ? { type: p.type } : {}),
    },
  };
};

export const createNotification = async (userIdOrPayload, title, message, metadata = {}) => {
    const {
      userId,
      title: resolvedTitle,
      message: resolvedMessage,
      metadata: resolvedMetadata,
    } = normaliseArgs(userIdOrPayload, title, message, metadata);

    // Fail loudly instead of writing a row with an undefined title. The UI in
    // both apps picks its icon with `title.includes(...)`, which throws on a
    // null title -- a bad row breaks the whole notification list, not just its
    // own entry.
    if (!userId || !resolvedTitle) {
        Logger.error(
          `createNotification called with invalid arguments (userId=${JSON.stringify(userId)}, title=${JSON.stringify(resolvedTitle)}) -- notification NOT created`
        );
        return null;
    }

    Logger.debug(`Creating notification for user ${userId}: ${resolvedTitle}`);
    try {
        // 1. Create DB Record
        const notification = await prisma.notification.create({
            data: {
                userId,
                title: resolvedTitle,
                message: resolvedMessage ?? '',
                // Persisted so the apps can pick an icon and a tap destination
                // from the notification's actual kind. Previously `metadata`
                // was accepted and then thrown away, which is why both apps
                // resort to substring-matching the title text.
                type: resolvedMetadata.type ?? null,
                data: resolvedMetadata.data ?? null,
                createdAt: new Date()
            }
        });

        // 2. Fetch User to get Token
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { pushToken: true }
        });

        Logger.debug(`User ${userId} pushToken: ${user?.pushToken ? 'present' : 'missing'}`);
        // 3. Send Push if token exists
        if (user?.pushToken && Expo.isExpoPushToken(user.pushToken)) {
            const isBookingAlert = resolvedMetadata.type === 'NEW_BOOKING_ALERT';
            const channelId = isBookingAlert ? 'booking-alerts-v7' : 'default-notifications';
            const messages = [{
                to: user.pushToken,
                sound: isBookingAlert ? 'alert_beep' : 'default', // DO NOT specify custom sound name here for android background
                title: resolvedTitle,
                body: resolvedMessage ?? '',
                data: { ...resolvedMetadata, userId },
                priority: isBookingAlert ? 'high' : 'normal',
                channelId: channelId,
                badge: 1,
                _displayInForeground: true,
                android: {
                    channelId: channelId,
                    sticky: true
                }
            }];

            Logger.debug('Message payload:', messages);
            const chunks = expo.chunkPushNotifications(messages);
            for (let chunk of chunks) {
                try {
                Logger.debug(`Sending internal push chunk to ${user.pushToken}`);
                let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                Logger.debug("Expo Ticket:", ticketChunk);
                // A ticket can come back with status 'error' on a 200 response
                // -- most often DeviceNotRegistered for an uninstalled app.
                // Without this the send looks successful in the logs forever.
                for (const ticket of ticketChunk || []) {
                    if (ticket?.status === 'error') {
                        Logger.error(
                          `Expo push rejected for user ${userId}: ${ticket.message} (${ticket.details?.error || 'no detail'})`
                        );
                    }
                }
                } catch (error) {
                Logger.error("Error sending push notification chunk:", error);
                }
            }
        }

        // Browser (vendor portal) push, alongside the Expo push above. Not awaited:
        // it can take seconds per subscription and must never delay or fail the
        // request that created the notification. sendWebPushToUser never throws.
        sendWebPushToUser(userId, {
            title: resolvedTitle,
            message: resolvedMessage,
            metadata: resolvedMetadata,
        });

        return notification;
    } catch (error) {
        // Kept non-throwing on purpose -- a notification failure must not roll
        // back the booking/payment that triggered it. But it is logged with
        // enough context to actually find, which it was not before.
        Logger.error(
          `Error creating notification for user ${userId} ("${resolvedTitle}"):`,
          error
        );
        return null;
    }
};

export const sendPushNotification = async (expoPushToken, title, body, data = {}) => {
  // Guard the token before building a payload for it. This used to be handed
  // an FCM token by the dispute flow, which Expo can only reject.
  if (!expoPushToken || !Expo.isExpoPushToken(expoPushToken)) {
    Logger.warn(
      `sendPushNotification called with a token Expo cannot use (${expoPushToken ? 'wrong format' : 'missing'}) -- skipping`
    );
    return null;
  }

  Logger.debug('Sending push notification to token:', expoPushToken?.substring(0, 20) + '...');
  const isBookingAlert = data.type === 'NEW_BOOKING_ALERT';
  const isChatMessage = data.type === 'NEW_MESSAGE';
  const channelId = isBookingAlert ? 'booking-alerts-v7' : (isChatMessage ? 'chat-messages' : 'default-notifications');
  const message = {
    to: expoPushToken,
    title: title,
    body: body,
    data: { ...data },
    priority: isBookingAlert ? 'high' : 'normal',
    sound: isBookingAlert ? 'alert_beep' : 'default',
    channelId: channelId,
    badge: 1,
    _displayInForeground: true,
    android: {
      channelId: channelId,
      priority: isBookingAlert ? 'max' : 'default',
      vibrate: isBookingAlert ? [0, 250, 250, 250] : [],
      sticky: true
    }
  };

  try {
    const ticket = await expo.sendPushNotificationsAsync([message]);
    Logger.info('Push notification sent successfully:', ticket);

    // Check for errors in the ticket
    if (ticket[0]?.status === 'error') {
      Logger.error('Push notification error:', ticket[0].message);
    }

    return ticket;
  } catch (error) {
    Logger.error('Failed to send push notification:', error);
    throw error;
  }
};
