import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get Vendor Notifications
// @route   GET /interactions/api/users/:user_id/notifications/ (Shared endpoint pattern)
export const getVendorNotifications = async (req, res) => {
    try {
        const notifications = await prisma.notification.findMany({
            where: { userId: parseInt(req.params.user_id) }, // Vendor is also a user
            orderBy: { createdAt: 'desc' }
        });
        res.json(notifications);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Mark Notification as read
export const markVendorRead = async (req, res) => {
    try {
        const notification = await prisma.notification.update({
            where: { id: parseInt(req.params.id) },
            data: { is_read: true }
        });
        res.json(notification);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}
