import prisma from "../../util/prisma.js";



// @desc    Get Vendor Notifications
// @route   GET /interactions/api/users/:user_id/notifications/ (Shared endpoint pattern)
export const getVendorNotifications = async (req, res) => {
    try {
        const userId = req.params.user_id ? parseInt(req.params.user_id) : req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const isRead = req.query.isRead;

        const where = { userId: userId };
        if (isRead !== undefined) {
            where.is_read = isRead === 'true';
        }

        const [notifications, total] = await Promise.all([
            prisma.notification.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit
            }),
            prisma.notification.count({ where })
        ]);

        res.json({
            notifications,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });
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




