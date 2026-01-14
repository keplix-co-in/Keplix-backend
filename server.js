import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { notFound, errorHandler } from "./middleware/errorMiddleware.js";
import logger from "./middleware/loggerMiddleware.js";
import helmet from "helmet";
import corsOptions from "./util/cors.js";

//
// Configurations
dotenv.config();
const app = express();
const httpServer = createServer(app);

//CORS config also used in socket.io
const io = new Server(httpServer, {
  cors: {
    origin: corsOptions.origin, // Allow all origins for development
    methods: ["GET", "POST"],
    credentials:true
  },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(logger); // Apply Logger first

app.use(helmet()); // for security headers
app.use(helmet.frameguard({ action: "deny" })); //prevent clickjacking here

//XSS (CSP Prevented)
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: [
        "'self'",
        "http://localhost:3000", // frontend dev
        "ws://localhost:8000", // socket.io
      ],
      frameSrc: ["'none'"], // no iframes allowed
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  })
);

app.use(cors(corsOptions));  //CORS origins allowed based on environment
app.use(express.json());
app.use("/media", express.static(path.join(__dirname, "media")));

// Database Check Route
app.get("/", (req, res) => {
  res.json({ message: "Keplix Backend (Node.js) is running!" });
});

// Import Routes (To be implemented)
import authRoutes from "./routes/auth.js";
// Vendor Routes
import vendorServiceRoutes from "./routes/vendor/services.js";
import vendorBookingRoutes from "./routes/vendor/bookings.js";
import inventoryRoutes from "./routes/vendor/inventory.js";
import availabilityRoutes from "./routes/vendor/availability.js";
import documentRoutes from "./routes/vendor/documents.js";
import promotionRoutes from "./routes/vendor/promotions.js";

// User Routes
import userServiceRoutes from "./routes/user/services.js";
import userBookingRoutes from "./routes/user/bookings.js";
import feedbackRoutes from "./routes/user/feedback.js";
import reviewRoutes from "./routes/user/reviews.js";
import userPaymentRoutes from "./routes/user/payments.js";
import userNotificationRoutes from "./routes/user/notifications.js";
import userInteractionRoutes from "./routes/user/interactions.js";

// Shared/Interaction Routes
// import interactionRoutes from './routes/interactions.js';
// import notificationRoutes from './routes/notifications.js';
// import paymentRoutes from './routes/payments.js';
import vendorProfileRoutes from "./routes/vendor/profile.js"; // Added
import vendorPaymentRoutes from "./routes/vendor/payments.js";
import vendorReviewRoutes from "./routes/vendor/reviews.js";
import vendorFeedbackRoutes from "./routes/vendor/feedback.js";
import vendorInteractionRoutes from "./routes/vendor/interactions.js";
import vendorNotificationRoutes from "./routes/vendor/notifications.js";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

app.use("/accounts/auth", authRoutes);
app.use("/accounts/vendor", vendorProfileRoutes); // Mounts /accounts/vendor/profile/

// Vendor API Group
app.use("/accounts/documents", documentRoutes);
app.use("/service_api/vendor", vendorServiceRoutes); // mounts /service_api/vendor/services
app.use("/service_api/vendor", vendorBookingRoutes); // mounts /service_api/vendor/bookings
app.use("/service_api", inventoryRoutes); // Keeps /service_api/vendor/:id/inventory
app.use("/service_api", availabilityRoutes); // Keeps /service_api/vendor/:id/availability
app.use("/interactions/api/promotions", promotionRoutes);
app.use("/interactions/api/vendor/reviews", vendorReviewRoutes); // /interactions/api/vendor/reviews
app.use("/interactions/api/vendor/feedback", vendorFeedbackRoutes); // /interactions/api/vendor/feedback
app.use("/interactions/api/vendor", vendorInteractionRoutes); // /interactions/api/vendor/conversations
app.use("/interactions/api/vendor", vendorNotificationRoutes); // /interactions/api/vendor/notifications

// User API Group
app.use("/service_api/user", userServiceRoutes); // mounts /service_api/user/services
app.use("/service_api/user", userBookingRoutes); // mounts /service_api/user/bookings
app.use("/service_api", userServiceRoutes); // For shared search routes like /service_api/search
// Note: /service_api/services/:id is also in user service controller, but mounted under /user currently?
// Let's ensure public routes work. userServiceRoutes has /services (public), /search etc.
// We might need to mount it at /service_api too for the public endpoints
app.use("/service_api", userServiceRoutes);

app.use("/interactions/api/feedback", feedbackRoutes); // User feedback
app.use("/interactions/api", reviewRoutes); // User reviews (public view of vendor reviews)

// Shared -> Specific
// app.use('/service_api', paymentRoutes);
app.use("/service_api", userPaymentRoutes);
app.use("/service_api", vendorPaymentRoutes);

// app.use('/interactions/api', interactionRoutes);
app.use("/interactions/api", userInteractionRoutes);
// app.use('/interactions/api', notificationRoutes);
app.use("/interactions/api", userNotificationRoutes);

// Socket.io Logic
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join_room", (room) => {
    socket.join(room);
    console.log(`User ${socket.id} joined room ${room}`);
  });

  socket.on("send_message", async (data) => {
    // data: { room, message, senderId, conversationId }
    try {
      if (data.conversationId && data.message && data.senderId) {
        const savedMessage = await prisma.message.create({
          data: {
            conversationId: parseInt(data.conversationId),
            senderId: parseInt(data.senderId),
            message_text: data.message,
          },
          include: { sender: true },
        });

        // Emit detailed object
        io.to(data.room).emit("receive_message", savedMessage);
      } else {
        // Fallback for testing
        io.to(data.room).emit("receive_message", data);
      }
    } catch (e) {
      console.error("Socket Error", e);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Error Handling Middleware (Must be last)
app.use(notFound);
app.use(errorHandler);

const PORT = 8000;
httpServer.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
