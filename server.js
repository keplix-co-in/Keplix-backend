import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { notFound, errorHandler } from "./middleware/errorMiddleware.js";
import helmet from "helmet";
import corsOptions, { allowedOrigins } from "./util/cors.js";
import compression from "compression";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import Logger from "./util/logger.js";
import loggerMiddleware from "./middleware/loggerMiddleware.js"

//
// Configurations
dotenv.config();
const app = express();
const httpServer = createServer(app);

// Rate Limiter: General API Limiter (300 requests per 15 minutes)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 300, 
  standardHeaders: true, 
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." }
});

// Auth Limiter: Stricter for Login/Register (10 requests per 15 minutes)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts, please try again later." }
});

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
});

app.set("io",io); // Make io accessible in routes via req.app.get('io')

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(loggerMiddleware);
// app.use(morgan("combined", { stream: { write: (message) => Logger.http(message.trim()) } })); // HTTP Logging
app.use(helmet()); 
app.use(helmet.frameguard({ action: "deny" })); 
app.use(compression()); // Compress responses
// Rate limit applied later to exclude static files

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
        "http://localhost:3000",
        "ws://localhost:8000",
        ...allowedOrigins 
      ],
      frameSrc: ["'none'"], // no iframes allowed
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  })
);


app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      // In development, you might want to log this to see what's being blocked
      Logger.warn(`Blocked by CORS:', ${origin}`);
      // For strictly blocking unknown origins:
      // var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      // return callback(new Error(msg), false);
      
      // For now, in dev, let's be permissive but log it. 
      // UNCOMMENT the validation above for production.
      return callback(null, true); 
    }
    return callback(null, true);
  },
  credentials: true
}));
app.use(cors(corsOptions));  //CORS origins allowed based on environment
app.use(express.json());
app.use("/media", express.static(path.join(__dirname, "media")));

// Apply Global Rate Limiter (Excludes static files)
app.use(limiter);

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

app.use("/accounts/auth", authLimiter, authRoutes);
app.use("/accounts/vendor", vendorProfileRoutes); // Mounts /accounts/vendor/profile/

// Vendor API Group
app.use("/accounts/documents", documentRoutes);
app.use("/service_api/vendor", vendorServiceRoutes); // mounts /service_api/vendor/services
app.use("/service_api/vendor", vendorBookingRoutes); // mounts /service_api/vendor/bookings
app.use("/service_api", inventoryRoutes); // Keeps /service_api/vendor/:id/inventory
app.use("/service_api", availabilityRoutes); // Keeps /service_api/vendor/:id/availability
app.use("/interactions/vendors", promotionRoutes); // Changed from /interactions/api/promotions to match frontend
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
  Logger.info(`User connected:", ${socket.id}`);

  // 1. Join a specific chat room (Conversation ID)
  socket.on('join_conversation', (conversationId) => {
    socket.join(conversationId);
    console.log(`User/Vendor joined room: ${conversationId}`);
  });

  // 2. Handle Sending Messages
  socket.on('send_message', async (data) => {
    // data = { conversationId, senderType, text }
    const { conversationId, senderType, text } = data;

    try {
      // A. Save to Database (Postgres)
      const newMessage = await prisma.message.create({
        data: {
          conversationId,
          senderType,
          text,
        },
      });

      // B. Send to everyone in that room (including sender, for confirmation)
      io.to(conversationId).emit('receive_message', newMessage); 
      
      // C. Optional: Send Push Notification (FCM) to the other party here

    } catch (error) {
      console.error('Socket Message Error:', error);
      socket.emit('error', { message: 'Message could not be sent' });
    }
  });

  socket.on("disconnect", () => {
    Logger.info(`User disconnected:, ${socket.id}`);
  });
});

// Error Handling Middleware (Must be last)
app.use(notFound);  // Re-enabled
app.use(errorHandler);

const PORT = 8000;
httpServer.listen(PORT, () => {
  Logger.info(`http://localhost:${PORT}`);
});
