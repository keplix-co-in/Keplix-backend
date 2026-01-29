import { PrismaClient } from "@prisma/client";
import { getIO } from "../../socket.js";

const prisma = new PrismaClient();

// @desc    Get all conversations for user (Customer)
// @route   GET /interactions/api/conversations/

export const createConversationId = async (req, res) => {
  try {
    const { bookingId } = req.body;
    const userId = req.user.id;

    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID is required" });
    }

    // 1. Check if conversation already exists for this booking
    let conversation = await prisma.conversation.findFirst({
      where: { bookingId: Number(bookingId) },
    });

    // 2. If it exists, return it
    if (conversation) {
      return res.status(200).json(conversation);
    }

    // 3. If NOT, verify booking and get Vendor ID
    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // 4. Create NEW Conversation
    conversation = await prisma.conversation.create({
      data: {
        bookingId: Number(bookingId),
        userId: userId, // Current User
        vendorId: booking.vendorId, // Vendor from the booking
        updatedAt: new Date(),
      },
    });

    return res.status(201).json(conversation);
  } catch (error) {
    console.error("Init Chat Error:", error);
    res.status(500).json({ message: "Failed to initiate conversation" });
  }
};

export const getConversations = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. As Customer: Find bookings where I am the user
    const customerBookings = await prisma.booking.findMany({
      where: { userId: userId },
      select: { id: true },
    });

    const allBookingIds = customerBookings.map((b) => b.id);

    const conversations = await prisma.conversation.findMany({
      where: { bookingId: { in: allBookingIds } },
      include: {
        booking: {
          include: {
            user: { include: { userProfile: true } },
            service: {
              include: { vendor: { include: { vendorProfile: true } } },
            },
          },
        },
        messages: {
          orderBy: { sent_at: "desc" },
          take: 1,
        },
      },
    });

    res.json(conversations);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get messages for a specific conversation
// @route   GET /interactions/api/chat/:conversationId
export const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;

    // Validate access here (check if req.user.id belongs to this conversation)

    const messages = await prisma.message.findMany({
      where: { conversationId: Number(conversationId) }, // Ensure ID is a number
      orderBy: { sent_at: "asc" }, // Correct field name
      include: {
        sender: {
          select: {
            id: true,
            role: true,
          },
        },
      },
    });

    res.json(messages); // Return array directly for easier frontend mapping or { data: messages }
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Send a message
// @route   POST /interactions/api/chat/send
export const sendMessage = async (req, res) => {
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
          },
        },
      },
    });

    // Update conversation updated_at
    await prisma.conversation.update({
      where: { id: Number(conversationId) },
      data: { updatedAt: new Date() },
    });

    // Socket.io Emit
    try {
      const io = getIO();
      io.to(String(conversationId)).emit("receive_message", message);
    } catch (socketError) {
      console.error("Socket emit failed:", socketError);
      // Don't fail the request if socket fails, message is saved
    }

    res.status(201).json(message);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to send message" });
  }
};
