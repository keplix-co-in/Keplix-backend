import prisma from "../../util/prisma.js";



// @desc    Get User Notifications
// @route   GET /interactions/api/users/:user_id/notifications/
export const getNotifications = async (req, res) => {
    try {
        const notifications = await prisma.notification.findMany({
            where: { userId: parseInt(req.params.user_id) },
            orderBy: { createdAt: 'desc' }
        });
        res.json(notifications);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Mark Notification as read
// @route   PUT /interactions/api/notifications/:id/mark-read/
export const markRead = async (req, res) => {
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

// @desc    Mark all notifications as read
// @route   PUT /service_api/user/:userId/notifications/read-all
export const markAllRead = async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        
        if (req.user.id !== userId) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        await prisma.notification.updateMany({
            where: { userId: userId, is_read: false },
            data: { is_read: true }
        });
        
        res.json({ message: 'All notifications marked as read' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Delete notification
// @route   DELETE /service_api/user/:userId/notifications/:id
export const deleteNotification = async (req, res) => {
    try {
        const notificationId = parseInt(req.params.id);
        const userId = parseInt(req.params.userId);

        const notification = await prisma.notification.findUnique({
            where: { id: notificationId }
        });

        if (!notification || notification.userId !== userId || req.user.id !== userId) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        await prisma.notification.delete({
            where: { id: notificationId }
        });

        res.json({ message: 'Notification deleted' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Update FCM Token
// @route   PUT /interactions/api/users/fcm-token/
export const updateFcmToken = async (req, res) => {
    const { fcmToken } = req.body;
    const userId = req.user.id; // From authMiddleware

    try {
        await prisma.user.update({
            where: { id: userId },
            data: { fcmToken }
        });
        res.json({ message: 'FCM Token Updated' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Create Notification (Internal/Admin)
// @route   POST /interactions/api/notifications/create/
export const createNotification = async (req, res) => {
    const { user_id, title, message } = req.body;
    //console.log(user_id)
    try {
        const notif = await prisma.notification.create({
            data: {
                userId: parseInt(user_id),
                title,
                message
            }
        });
        res.status(201).json(notif);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}


