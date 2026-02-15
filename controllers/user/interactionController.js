import prisma from 'file:///C:/keplix-frontend-master/keplix-backend/util/prisma.js';
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

    // 1. Verify booking belongs to user
    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
      include: { conversation: true }
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== userId) {
      return res.status(403).json({ message: "Not authorized for this booking" });
    }

    // 2. Return conversation if exists, null if not
    if (booking.conversation) {
      return res.status(200).json(booking.conversation);
    } else {
      return res.status(404).json({ message: "No conversation found for this booking" });
    }

  } catch (error) {
    console.error("Get Conversation By Booking Error:", error);
    return res.status(500).json({
      message: "Failed to fetch conversation"
    });
  }
};

// @desc    Create conversation for a booking (User Side)
// @route   POST /interactions/api/user/conversations/create
export const createConversationId = async (req, res) => {
  try {
    const { bookingId } = req.body;
    const userId = req.user.id;

    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID is required" });
    }

    // 1. Fetch booking
    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
    });
    

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // 2. Security: booking must belong to logged-in user
    if (booking.userId !== userId) {
      return res
        .status(403)
        .json({ message: "Not authorized for this booking" });
    }

    // 3. Check if conversation already exists (idempotent)
    let conversation = await prisma.conversation.findFirst({
      where: { bookingId: booking.id },
    });

    if (conversation) {
      return res.status(200).json(conversation);
    }

    // 4. Create new conversation
    conversation = await prisma.conversation.create({
      data: {
        bookingId: booking.id,
        updatedAt: new Date(),
      },
    });

    return res.status(201).json(conversation);
  } catch (error) {
    console.error("Create Conversation Error:", error);
    return res.status(500).json({
      message: "Failed to create conversation",
    });
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
      console.log(`[Socket] Emitting message to room ${conversationId}:`, message.id);
      io.to(String(conversationId)).emit("receive_message", message);
      console.log(`[Socket] Message emitted successfully`);
      
      // Notify other participant of the conversation
      const conversation = await prisma.conversation.findUnique({
        where: { id: Number(conversationId) },
        include: {
          booking: {
            include: {
              service: { select: { vendorId: true } }
            }
          }
        }
      });

      if (conversation && conversation.booking) {
        const receiverId = senderId === conversation.booking.userId 
          ? conversation.booking.service.vendorId 
          : conversation.booking.userId;

        await createNotification(
          receiverId, 
          "New Message", 
          `You have a new message: ${message_text.substring(0, 50)}${message_text.length > 50 ? '...' : ''}`,
          { type: 'NEW_MESSAGE', conversationId: Number(conversationId) }
        );
      }
    } catch (socketError) {
      console.error("Socket emit/notify failed:", socketError);
    }

    res.status(201).json(message);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to send message" });
  }
};


