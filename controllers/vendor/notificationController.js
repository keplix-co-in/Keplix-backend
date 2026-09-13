import prisma from "../../util/prisma.js";



// @desc    Get Vendor Notifications
// @route   GET /interactions/api/users/:user_id/notifications/ (Shared endpoint pattern)
export const getVendorNotifications = async (req, res) => {
    try {
        // IDOR fix: this route carries no admin-role check, so :user_id must
        // never be trusted from the URL — any authenticated account could
        // otherwise read any other account's notifications by supplying a
        // different id. There is no legitimate case here where the caller
        // should see anyone's notifications but their own.
        const userId = req.user.id;
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
        // IDOR fix: previously updated by `id` alone, so any authenticated
        // account could mark (and thereby read the existence/content of) any
        // other account's notification as read. `updateMany` with both
        // `id` and `userId` in the where clause means a mismatched owner
        // simply matches zero rows instead of updating someone else's data.
        const result = await prisma.notification.updateMany({
            where: { id: parseInt(req.params.id), userId: req.user.id },
            data: { is_read: true }
        });
        if (result.count === 0) {
            return res.status(404).json({ message: 'Notification not found' });
        }
        res.json({ message: 'Notification marked as read' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}




