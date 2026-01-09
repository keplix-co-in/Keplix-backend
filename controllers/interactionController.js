import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get all conversations for user
// @route   GET /interactions/api/conversations/
export const getConversations = async (req, res) => {
    try {
        const userId = req.user.id; // User or Vendor

        // Find conversations where user is involved (linked to booking)
        // This logic mimics Django logic: User sees bookings they made; Vendor sees bookings for their services.
        // Simplified: We find bookings where userId is participant

        // 1. As Customer
        const customerBookings = await prisma.booking.findMany({
            where: { userId: userId },
            select: { id: true }
        });

        // 2. As Vendor (Service Provider)
        const vendorServices = await prisma.service.findMany({
            where: { vendorId: userId },
            select: { id: true }
        });
        const vendorServiceIds = vendorServices.map(s => s.id);
        const vendorBookings = await prisma.booking.findMany({
            where: { serviceId: { in: vendorServiceIds } },
            select: { id: true }
        });

        const allBookingIds = [...customerBookings.map(b => b.id), ...vendorBookings.map(b => b.id)];

        const conversations = await prisma.conversation.findMany({
            where: { bookingId: { in: allBookingIds } },
            include: {
                booking: {
                    include: {
                        user: { include: { userProfile: true } }, // Customer details
                        service: { include: { vendor: { include: { vendorProfile: true } } } } // Vendor details
                    }
                },
                messages: {
                    orderBy: { sent_at: 'desc' },
                    take: 1
                }
            }
        });

        res.json(conversations);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get messages for a conversation
// @route   GET /interactions/api/messages/?conversation_id=X
export const getMessages = async (req, res) => {
    const conversationId = req.query.conversation_id;

    if (!conversationId) {
        return res.status(400).json({ message: 'Conversation ID required' });
    }

    try {
        const messages = await prisma.message.findMany({
            where: { conversationId: parseInt(conversationId) },
            orderBy: { sent_at: 'asc' },
            include: { sender: true }
        });

        res.json(messages);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};
