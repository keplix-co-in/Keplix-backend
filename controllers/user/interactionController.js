import prisma from "../../util/prisma.js";
import { getIO } from "../../socket.js";
import { createNotification } from "../../util/notificationHelper.js";



// @desc    Get conversation by booking ID
// @route   GET /interactions/api/user/bookings/:bookingId/conversation
export const getConversationByBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const userId = req.user.id;

    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID is required" });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
      include: { conversation: true },
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    if (booking.conversation) {
      return res.status(200).json(booking.conversation);
    }

    return res.status(404).json({ message: "No conversation found" });
  } catch (error) {
    console.error("Get Conversation Error:", error);
    res.status(500).json({ message: "Failed to fetch conversation" });
  }
};

// @desc Create conversation
export const createConversationId = async (req, res) => {
  try {
    const { bookingId } = req.body;
    const userId = req.user.id;

    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID required" });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    let conversation = await prisma.conversation.findFirst({
      where: { bookingId: booking.id },
    });

    if (conversation) {
      return res.status(200).json(conversation);
    }

    conversation = await prisma.conversation.create({
      data: {
        bookingId: booking.id,
        updatedAt: new Date(),
      },
    });

    return res.status(201).json(conversation);
  } catch (error) {
    console.error("Create Conversation Error:", error);
    res.status(500).json({ message: "Failed to create conversation" });
  }
};

// FIXED & OPTIMIZED
export const getConversations = async (req, res) => {
  try {
    const userId = req.user.id;
    const { cursor, limit = 20 } = req.query;

    const safeLimit = Math.min(Number(limit), 50);

    const conversations = await prisma.conversation.findMany({
      where: {
        booking: {
          userId: userId, // direct relation filter
        },
      },

      include: {
        booking: {
          include: {
            user: { include: { userProfile: true } },
            service: {
              include: {
                vendor: { include: { vendorProfile: true } },
              },
            },
          },
        },
        messages: {
          orderBy: { sent_at: "desc" },
          take: 1,
        },
      },

      orderBy: {
        updatedAt: "desc",
      },

      take: safeLimit,

      ...(cursor && {
        skip: 1,
        cursor: { id: Number(cursor) },
      }),
    });

    res.json({
      success: true,
      count: conversations.length,
      data: conversations,
      nextCursor:
        conversations.length > 0
          ? conversations[conversations.length - 1].id
          : null,
    });
  } catch (error) {
    console.error("Get Conversations Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc Get messages
export const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;

    const messages = await prisma.message.findMany({
      where: { conversationId: Number(conversationId) },
      orderBy: { sent_at: "asc" },
      include: {
        sender: {
          select: {
            id: true,
            role: true,
          },
        },
      },
    });

    res.json(messages);
  } catch (error) {
    console.error("Get Messages Error:", error);
    res.status(500).json({ message: "Failed to fetch messages" });
  }
};

// @desc Send message
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
        senderId,
        message_text,
      },
      include: {
        sender: {
          select: { id: true, role: true },
        },
      },
    });

    await prisma.conversation.update({
      where: { id: Number(conversationId) },
      data: { updatedAt: new Date() },
    });

    // Socket + Notification
    try {
      const io = getIO();
      io.to(String(conversationId)).emit("receive_message", message);

      const conversation = await prisma.conversation.findUnique({
        where: { id: Number(conversationId) },
        include: {
          booking: {
            include: {
              service: { select: { vendorId: true } },
            },
          },
        },
      });

      if (conversation?.booking) {
        const receiverId =
          senderId === conversation.booking.userId
            ? conversation.booking.service.vendorId
            : conversation.booking.userId;

        await createNotification(
          receiverId,
          "New Message",
          `You have a new message: ${message_text.slice(0, 50)}`,
          { type: "NEW_MESSAGE", conversationId: Number(conversationId) }
        );
      }
    } catch (err) {
      console.error("Socket/Notification Error:", err);
    }

    res.status(201).json(message);
  } catch (error) {
    console.error("Send Message Error:", error);
    res.status(500).json({ message: "Failed to send message" });
  }
};