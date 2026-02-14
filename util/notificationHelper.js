import { PrismaClient } from "@prisma/client";
import { Expo } from 'expo-server-sdk';

const prisma = new PrismaClient();
const expo = new Expo();

export const createNotification = async (userId, title, message, metadata = {}) => {
    console.log(`🔔 Creating notification for user ${userId}: ${title}`);
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

        console.log(`👤 User ${userId} pushToken: ${user?.pushToken ? 'present' : 'missing'}`);

        // 3. Send Push if token exists
        if (user?.pushToken && Expo.isExpoPushToken(user.pushToken)) {
            const messages = [{
                to: user.pushToken,
                sound: 'default', 
                title: title,
                body: message,
                data: { ...metadata, userId },
                priority: 'high', 
                channelId: 'booking-alerts-v5', // Ensure v5
                android: {
                    channelId: 'booking-alerts-v5', // Ensure v5
                    sound: 'alert_beep', // Custom sound
                }
            }];

            console.log('📤 Message payload:', JSON.stringify(messages, null, 2));
            const chunks = expo.chunkPushNotifications(messages);
            for (let chunk of chunks) {
                try {
                console.log(`📤 Sending internal push chunk to ${user.pushToken}`);
                let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                console.log("✅ Expo Ticket:", JSON.stringify(ticketChunk));
                } catch (error) {
                console.error("Error sending push notification chunk:", error);
                }
            }
        }
    } catch (error) {
        console.error("Error creating notification:", error);
    }
};

export const sendPushNotification = async (expoPushToken, title, body, data = {}) => {
  console.log('📤 Sending push notification to token:', expoPushToken?.substring(0, 20) + '...');
  
  const message = {
    to: expoPushToken,
    title: title,
    body: body,
    data: { ...data },
    priority: 'high',
    android: {
      channelId: 'booking-alerts',
      sound: 'alert_beep',
      priority: 'max',
      vibrate: [0, 250, 250, 250],
    }
  };

  try {
    const ticket = await expo.sendPushNotificationsAsync([message]);
    console.log('✅ Push notification sent successfully:', ticket);
    
    // Check for errors in the ticket
    if (ticket[0]?.status === 'error') {
      console.error('❌ Push notification error:', ticket[0].message);
    }
    
    return ticket;
  } catch (error) {
    console.error('❌ Failed to send push notification:', error);
    throw error;
  }
};
