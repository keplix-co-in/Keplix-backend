import { PrismaClient } from "@prisma/client";
import { Expo } from 'expo-server-sdk';

const prisma = new PrismaClient();
const expo = new Expo();

export const createNotification = async (userId, title, message, metadata = {}) => {
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

        // 3. Send Push if token exists
        if (user?.pushToken && Expo.isExpoPushToken(user.pushToken)) {
            const messages = [{
                to: user.pushToken,
                sound: 'default', // Standard beep on iOS
                title: title,
                body: message,
                data: { ...metadata, userId },
                priority: 'high', // High priority for iOS to beep even when backgrounded
                channelId: 'booking-alerts', // Loud channel for Android
            }];

            // Send the chunks to the Expo push notification service
            // There are different strategies you could use. A simple one is to send one chunk at a time, which nicely spreads the load out over time:
            const chunks = expo.chunkPushNotifications(messages);
            for (let chunk of chunks) {
                try {
                let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                // console.log(ticketChunk);
                } catch (error) {
                console.error("Error sending push notification chunk:", error);
                }
            }
        }
    } catch (error) {
        console.error("Error creating notification:", error);
    }
};
