<<<<<<< HEAD
﻿import prisma from "../../util/prisma.js";
=======
import prisma from "../../util/prisma.js";
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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

<<<<<<< HEAD
    // 1. Verify booking belongs to user
    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
      include: { conversation: true }
=======
    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
      include: { conversation: true },
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId !== userId) {
<<<<<<< HEAD
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
=======
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
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
export const createConversationId = async (req, res) => {
  try {
    const { bookingId } = req.body;
    const userId = req.user.id;

    if (!bookingId) {
<<<<<<< HEAD
      return res.status(400).json({ message: "Booking ID is required" });
    }

    // 1. Fetch booking
    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
    });
    
=======
      return res.status(400).json({ message: "Booking ID required" });
    }

    const booking = await prisma.booking.findUnique({
      where: { id: Number(bookingId) },
    });
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

<<<<<<< HEAD
    // 2. Security: booking must belong to logged-in user
    if (booking.userId !== userId) {
      return res
        .status(403)
        .json({ message: "Not authorized for this booking" });
    }

    // 3. Check if conversation already exists (idempotent)
=======
    if (booking.userId !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    let conversation = await prisma.conversation.findFirst({
      where: { bookingId: booking.id },
    });

    if (conversation) {
      return res.status(200).json(conversation);
    }

<<<<<<< HEAD
    // 4. Create new conversation
=======
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    conversation = await prisma.conversation.create({
      data: {
        bookingId: booking.id,
        updatedAt: new Date(),
      },
    });

    return res.status(201).json(conversation);
  } catch (error) {
    console.error("Create Conversation Error:", error);
<<<<<<< HEAD
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
=======
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

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
      include: {
        booking: {
          include: {
            user: { include: { userProfile: true } },
            service: {
<<<<<<< HEAD
              include: { vendor: { include: { vendorProfile: true } } },
=======
              include: {
                vendor: { include: { vendorProfile: true } },
              },
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
            },
          },
        },
        messages: {
          orderBy: { sent_at: "desc" },
          take: 1,
        },
      },
<<<<<<< HEAD
    });

    res.json(conversations);
  } catch (error) {
    console.error(error);
=======

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
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    res.status(500).json({ message: "Server Error" });
  }
};

<<<<<<< HEAD
// @desc    Get messages for a specific conversation
// @route   GET /interactions/api/chat/:conversationId
export const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;

    // Validate access here (check if req.user.id belongs to this conversation)

    const messages = await prisma.message.findMany({
      where: { conversationId: Number(conversationId) }, // Ensure ID is a number
      orderBy: { sent_at: "asc" }, // Correct field name
=======
// @desc Get messages
export const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { limit = 50, before } = req.query; // before = message id cursor, for scrolling back

    const safeLimit = Math.min(Number(limit), 100);

    const where = { conversationId: Number(conversationId) };
    if (before) {
      where.id = { lt: Number(before) };
    }

    // Fetch newest-first (bounded by `take`), then reverse for chronological display.
    const messages = await prisma.message.findMany({
      where,
      orderBy: { id: "desc" },
      take: safeLimit,
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
      include: {
        sender: {
          select: {
            id: true,
            role: true,
          },
        },
      },
    });

<<<<<<< HEAD
    res.json(messages); // Return array directly for easier frontend mapping or { data: messages }
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Send a message
// @route   POST /interactions/api/chat/send
=======
    const nextCursor =
      messages.length === safeLimit
        ? messages[messages.length - 1].id
        : null;

    res.json({
      success: true,
      count: messages.length,
      data: messages.reverse(),
      nextCursor: nextCursor,
    });
  } catch (error) {
    console.error("Get Messages Error:", error);
    res.status(500).json({ message: "Failed to fetch messages" });
  }
};

// @desc Send message
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
export const sendMessage = async (req, res) => {
  try {
    const { conversationId, message_text } = req.body;
    const senderId = req.user.id;
<<<<<<< HEAD
=======

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    if (!conversationId || !message_text) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const message = await prisma.message.create({
      data: {
        conversationId: Number(conversationId),
<<<<<<< HEAD
        senderId: senderId,
        message_text: message_text,
      },
      include: {
        sender: {
          select: {
            id: true,
            role: true,
          },
=======
        senderId,
        message_text,
      },
      include: {
        sender: {
          select: { id: true, role: true },
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
        },
      },
    });

<<<<<<< HEAD
    // Update conversation updated_at
=======
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    await prisma.conversation.update({
      where: { id: Number(conversationId) },
      data: { updatedAt: new Date() },
    });

<<<<<<< HEAD
    // Socket.io Emit
    try {
      const io = getIO();
      io.to(String(conversationId)).emit("receive_message", message);
      
      // Notify other participant of the conversation
=======
    // Socket + Notification
    try {
      const io = getIO();
      io.to(String(conversationId)).emit("receive_message", message);

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
      const conversation = await prisma.conversation.findUnique({
        where: { id: Number(conversationId) },
        include: {
          booking: {
            include: {
<<<<<<< HEAD
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
=======
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
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    }

    res.status(201).json(message);
  } catch (error) {
<<<<<<< HEAD
    console.error(error);
    res.status(500).json({ message: "Failed to send message" });
  }
};


=======
    console.error("Send Message Error:", error);
    res.status(500).json({ message: "Failed to send message" });
  }
};
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
