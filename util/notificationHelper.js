import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const createNotification = async (userId, title, message) => {
    try {
        await prisma.notification.create({
            data: {
                userId,
                title,
                message,
                createdAt: new Date()
            }
        });
    } catch (error) {
        console.error("Error creating notification:", error);
    }
};
