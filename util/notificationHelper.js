import prisma from "../util/prisma.js";
import { Expo } from 'expo-server-sdk';
import Logger from './logger.js';


const expo = new Expo();

export const createNotification = async (userId, title, message, metadata = {}) => {
    Logger.debug(`Creating notification for user ${userId}: ${title}`);
    try {
        // 1. Create DB Record
        await prisma.notification.create({
            data: {
                userId,
                title,
                message,
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
            const isBookingAlert = metadata.type === 'NEW_BOOKING_ALERT';
            const channelId = isBookingAlert ? 'booking-alerts-v5' : 'default-notifications';
            
            const messages = [{
                to: user.pushToken,
                sound: isBookingAlert ? 'alert_beep' : 'default', 
                title: title,
                body: message,
                data: { ...metadata, userId },
                priority: isBookingAlert ? 'high' : 'normal', 
                channelId: channelId, 
                android: {
                    channelId: channelId,
                    sound: isBookingAlert ? 'alert_beep' : 'default', // device default for non-booking
                }
            }];

            Logger.debug('Message payload:', messages);
            const chunks = expo.chunkPushNotifications(messages);
            for (let chunk of chunks) {
                try {
                Logger.debug(`Sending internal push chunk to ${user.pushToken}`);
                let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                Logger.debug("Expo Ticket:", ticketChunk);
                } catch (error) {
                Logger.error("Error sending push notification chunk:", error);
                }
            }
        }
    } catch (error) {
        Logger.error("Error creating notification:", error);
    }
};

export const sendPushNotification = async (expoPushToken, title, body, data = {}) => {
  Logger.debug('Sending push notification to token:', expoPushToken?.substring(0, 20) + '...');
  
  const isBookingAlert = data.type === 'NEW_BOOKING_ALERT';
  const isChatMessage = data.type === 'NEW_MESSAGE';
  const channelId = isBookingAlert ? 'booking-alerts-v5' : (isChatMessage ? 'chat-messages' : 'default-notifications');

  const message = {
    to: expoPushToken,
    title: title,
    body: body,
    data: { ...data },
    priority: isBookingAlert ? 'high' : 'normal',
    sound: isBookingAlert ? 'alert_beep' : 'default', // device default for chat/other notifications
    channelId: channelId,
    android: {
      channelId: channelId,
      sound: isBookingAlert ? 'alert_beep' : 'default', // device default
      priority: isBookingAlert ? 'max' : 'default',
      vibrate: isBookingAlert ? [0, 250, 250, 250] : [],
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

