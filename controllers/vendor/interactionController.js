import { PrismaClient } from '@prisma/client';
import { getIO } from '../../socket.js';

const prisma = new PrismaClient();

// @desc    Create a conversation for a booking (Vendor Side)
// @route   POST /interactions/api/vendor/chat/create
export const createVendorConversation = async (req, res) => {
    try {
        const { bookingId } = req.body;
        const vendorId = req.user.id;

        if (!bookingId) {
            return res.status(400).json({ message: "Booking ID is required" });
        }

        // 1. Fetch booking and verify it belongs to vendor's service
        const booking = await prisma.booking.findUnique({
            where: { id: Number(bookingId) },
            include: { service: true }
        });

        if (!booking) {
            return res.status(404).json({ message: "Booking not found" });
        }

        // 2. Security: booking must be for vendor's service
        if (booking.service.vendorId !== vendorId) {
            return res.status(403).json({ message: "Not authorized for this booking" });
        }

        // 3. Check if conversation already exists (idempotent)
        let conversation = await prisma.conversation.findFirst({
            where: { bookingId: booking.id }
        });

        if (conversation) {
            return res.status(200).json(conversation);
        }

        // 4. Create new conversation
        conversation = await prisma.conversation.create({
            data: {
                bookingId: booking.id,
                updatedAt: new Date()
            }
        });

        return res.status(201).json(conversation);
    } catch (error) {
        console.error("Create Vendor Conversation Error:", error);
        return res.status(500).json({
            message: "Failed to create conversation"
        });
    }
};

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
// @route   GET /interactions/api/vendor/chat/:conversationId
export const getVendorMessages = async (req, res) => {
    try {
        const conversationId = req.params.conversationId || req.query.conversation_id;

        if (!conversationId) {
            return res.status(400).json({ message: 'Conversation ID required' });
        }

        const messages = await prisma.message.findMany({
            where: { conversationId: Number(conversationId) },
            orderBy: { sent_at: 'asc' }, // Ensure correct ordering
            include: { 
                sender: {
                    select: {
                        id: true,
                        role: true
                    }
                }
            }
        });

        res.json(messages); 
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Send a message (Vendor)
// @route   POST /interactions/api/vendor/chat/send
export const sendVendorMessage = async (req, res) => {
    try {
        const { conversationId, message_text } = req.body;
        const senderId = req.user.id; 

        if (!conversationId || !message_text) {
             return res.status(400).json({ message: "Missing fields" });
        }

        const message = await prisma.message.create({
            data: {
                conversationId: Number(conversationId),
                senderId: senderId,
                message_text: message_text,
            },
            include: {
                sender: { 
                     select: {
                        id: true,
                        role: true, 
                     }
                }
            }
        });
        
        // Update conversation updated_at
        await prisma.conversation.update({
            where: { id: Number(conversationId) },
            data: { updatedAt: new Date() }
        });

        // Socket.io Emit
        try {
            const io = getIO();
            console.log(`[Socket] Emitting message to room ${conversationId}:`, message.id);
            io.to(String(conversationId)).emit("receive_message", message);
            console.log(`[Socket] Message emitted successfully`);
        } catch (socketError) {
             console.error("Socket emit failed:", socketError);
        }

        res.status(201).json(message);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to send message' });
    }
};
