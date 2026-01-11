import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get all conversations for Vendor
// @route   GET /interactions/api/vendor/conversations/
export const getVendorConversations = async (req, res) => {
    try {
        const userId = req.user.id; // Vendor User ID

        // 2. As Vendor: Find bookings for my services
        const vendorServices = await prisma.service.findMany({
            where: { vendorId: userId },
            select: { id: true }
        });
        const vendorServiceIds = vendorServices.map(s => s.id);
        
        const vendorBookings = await prisma.booking.findMany({
            where: { serviceId: { in: vendorServiceIds } },
            select: { id: true }
        });

        const allBookingIds = vendorBookings.map(b => b.id);

        const conversations = await prisma.conversation.findMany({
            where: { bookingId: { in: allBookingIds } },
            include: {
                booking: {
                    include: {
                        user: { include: { userProfile: true } }, // Customer details
                        service: { include: { vendor: { include: { vendorProfile: true } } } } 
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
export const getVendorMessages = async (req, res) => {
    // Logic is same as user for now
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
