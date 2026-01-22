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
import loggerMiddleware from "./middleware/loggerMiddleware.js";
import sanitizeInput from "./middleware/sanitizeMiddleware.js";

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

// Auth Limiter: For Login/Register (50 requests per 15 minutes for development)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 50, // More lenient in dev
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many authentication attempts, please try again in a few minutes." },
  skip: (req) => {
    // Skip rate limiting for logout and token refresh
    return req.path.includes('/logout') || req.path.includes('/token/refresh');
  }
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
app.use(express.json({ limit: '50mb' })); // Increased limit for large payloads
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Parse URL-encoded bodies
app.use(sanitizeInput); // XSS protection and input sanitization
app.use("/media", express.static(path.join(__dirname, "media")));

// Apply Global Rate Limiter (Excludes static files)
app.use(limiter);

// Database Check Route
app.get("/", (req, res) => {
  res.json({ message: "Keplix Backend (Node.js) is running!" });
});

// Import Routes (To be implemented)
import authRoutes, { logoutRouter } from "./routes/auth.js";
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
import userProfileRoutes from "./routes/user/profile.js";
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

// Health check endpoint for Cloud Run
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Keplix Backend API', 
    version: '1.0.0',
    status: 'running'
  });
});

app.use("/accounts/auth", authLimiter, authRoutes);
app.use("/accounts/auth", logoutRouter); // Logout without rate limit
app.use("/accounts/vendor", vendorProfileRoutes); 

// Vendor API Group
app.use("/accounts/documents", documentRoutes);
app.use("/service_api/vendor", vendorServiceRoutes); 
app.use("/service_api/vendor", vendorBookingRoutes); 
app.use("/service_api", inventoryRoutes); 
app.use("/service_api", availabilityRoutes); 
app.use("/interactions/vendors", promotionRoutes); 
app.use("/interactions/api/vendor/reviews", vendorReviewRoutes); 
app.use("/interactions/api/vendor/feedback", vendorFeedbackRoutes); 
app.use("/interactions/api/vendor", vendorInteractionRoutes); 
app.use("/interactions/api/vendor", vendorNotificationRoutes); 

// User API Group
app.use("/service_api/user", userServiceRoutes); 
app.use("/service_api/user", userBookingRoutes); 
app.use("/service_api/user", userProfileRoutes); 
app.use("/service_api", userPaymentRoutes); // matches /service_api/payments/...
app.use("/service_api", userServiceRoutes); // matches /service_api/services/:id

app.use("/interactions/api/feedback", feedbackRoutes); 
app.use("/interactions/api", reviewRoutes); 
app.use("/interactions/api/user", userNotificationRoutes);
app.use("/interactions/api/user", userInteractionRoutes);

// Shared -> Specific
// app.use('/service_api', paymentRoutes);
app.use("/service-api", userPaymentRoutes);
app.use("/service-api", vendorPaymentRoutes);

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

// Cloud Run requires listening on the PORT environment variable
const PORT = process.env.PORT || 8000;
httpServer.listen(PORT, '0.0.0.0', () => {
  Logger.info(`http://localhost:${PORT}`);
  Logger.info(`Server running in ${process.env.NODE_ENV || 'development'} mode`);
});
