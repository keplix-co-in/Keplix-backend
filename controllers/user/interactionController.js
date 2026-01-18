import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get all conversations for user (Customer)
// @route   GET /interactions/api/conversations/
export const getConversations = async (req, res) => {
    try {
        const userId = req.user.id; 

        // 1. As Customer: Find bookings where I am the user
        const customerBookings = await prisma.booking.findMany({
            where: { userId: userId },
            select: { id: true }
        });

        const allBookingIds = customerBookings.map(b => b.id);

        const conversations = await prisma.conversation.findMany({
            where: { bookingId: { in: allBookingIds } },
            include: {
                booking: {
                    include: {
                        user: { include: { userProfile: true } }, 
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

// @desc    Get messages for a specific conversation
// @route   GET /interactions/api/chat/:conversationId
export const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    
    // Validate access here (check if req.user.id belongs to this conversation)

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' }, // Oldest first
    });

    res.json({ success: true, count: messages.length, data: messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
