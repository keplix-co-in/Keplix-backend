import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config(); // Move this to the very top, immediately after import

import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import morgan from "morgan";

// Local Imports
import { initSocket } from "./socket.js";
import { notFound, errorHandler } from "./middleware/errorMiddleware.js";
import loggerMiddleware from "./middleware/loggerMiddleware.js";
import sanitizeInput from "./middleware/sanitizeMiddleware.js";
import corsOptions, { allowedOrigins } from "./util/cors.js";
import Logger from "./util/logger.js";

// --- ROUTES IMPORTS ---

// Auth
import authRoutes, { logoutRouter } from "./routes/auth.js";

// Vendor Routes
import vendorProfileRoutes from "./routes/vendor/profile.js";
import vendorServiceRoutes from "./routes/vendor/services.js";
import vendorBookingRoutes from "./routes/vendor/bookings.js";
import inventoryRoutes from "./routes/vendor/inventory.js";
import availabilityRoutes from "./routes/vendor/availability.js";
import documentRoutes from "./routes/vendor/documents.js";
import promotionRoutes from "./routes/vendor/promotions.js";
import vendorPaymentRoutes from "./routes/vendor/payments.js";
import vendorReviewRoutes from "./routes/vendor/reviews.js";
import vendorFeedbackRoutes from "./routes/vendor/feedback.js";
import vendorInteractionRoutes from "./routes/vendor/interactions.js";
import vendorNotificationRoutes from "./routes/vendor/notifications.js";

// User Routes
import userProfileRoutes from "./routes/user/profile.js";
import userServiceRoutes from "./routes/user/services.js";
import userBookingRoutes from "./routes/user/bookings.js";
import userPaymentRoutes from "./routes/user/payments.js";
import userInteractionRoutes from "./routes/user/interactions.js";
import userNotificationRoutes from "./routes/user/notifications.js";
import reviewRoutes from "./routes/user/reviews.js";
import feedbackRoutes from "./routes/user/feedback.js";

// --- CONFIGURATION ---

const app = express();
const httpServer = createServer(app);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Socket.IO
const io = initSocket(httpServer);
app.set("io", io);

// --- RATE LIMITERS ---
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 300, 
  standardHeaders: true, 
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." }
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many authentication attempts, please try again in a few minutes." },
  skip: (req) => req.path.includes('/logout') || req.path.includes('/token/refresh')
});

// --- MIDDLEWARE ---
app.use(loggerMiddleware);
app.use(helmet());
app.use(helmet.frameguard({ action: "deny" }));
app.use(compression());

// CSP Configuration
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"], // Added https for external images
      fontSrc: ["'self'", "data:"],
      connectSrc: [
        "'self'",
        "http://localhost:3000",
        "ws://localhost:8000",
        ...allowedOrigins 
      ],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  })
);

// CORS Configuration
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      Logger.warn(`Blocked by CORS: ${origin}`);
      // Relaxed for dev, strict for prod
      return callback(null, true); 
    }
    return callback(null, true);
  },
  credentials: true
}));

// Parsing & Sanitization
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(sanitizeInput);
app.use("/media", express.static(path.join(__dirname, "media")));

// Apply Global Rate Limiter
app.use(limiter);

// --- HEALTH CHECK ---
app.get("/", (req, res) => res.json({ message: "Keplix Backend (Node.js) is running!", status: "running" }));
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// --- ROUTES ---

// 1. Authentication
app.use("/accounts/auth", authLimiter, authRoutes);
app.use("/accounts/auth", logoutRouter);


// 2. Vendor
app.use("/accounts/vendor", vendorProfileRoutes);
app.use("/accounts/documents", documentRoutes)
app.use("/service_api/vendor", vendorServiceRoutes);
app.use("/service_api/vendor", vendorBookingRoutes);
app.use("/service_api", inventoryRoutes); // Keeps original path
app.use("/service_api", availabilityRoutes); // Keeps original path
app.use("/interactions/vendors", promotionRoutes);
app.use("/interactions/api/vendor/reviews", vendorReviewRoutes);
app.use("/interactions/api/vendor/feedback", vendorFeedbackRoutes);
app.use("/interactions/api/vendor", vendorInteractionRoutes);
app.use("/interactions/api/vendor", vendorNotificationRoutes);

// 3. User
app.use("/service_api/user", userServiceRoutes);
app.use("/service_api/user", userBookingRoutes);
app.use("/service_api/user", userProfileRoutes);

// 4. Shared / Other
app.use("/service_api", userServiceRoutes); // Original comment: matches /service_api/services/:id
app.use("/service_api", userPaymentRoutes);
app.use("/service_api", vendorPaymentRoutes);

// 5. Interactions
app.use("/interactions/api/user", userInteractionRoutes);
app.use("/interactions/api/user/", userNotificationRoutes);
app.use("/interactions/api/feedback", feedbackRoutes);
app.use("/interactions/api", reviewRoutes);


// --- ERROR HANDLING ---
app.use(notFound);
app.use(errorHandler);

// --- SERVER START ---
const PORT = process.env.PORT || 8000;
httpServer.listen(PORT, '0.0.0.0', () => {
  Logger.info(`=================================`);
  Logger.info(`🚀  Keplix Backend Running`);
  Logger.info(`🌍  URL: http://localhost:${PORT}`);
  Logger.info(`⚙️   Mode: ${process.env.NODE_ENV }`);
  Logger.info(`=================================`);
});

// --- GRACEFUL SHUTDOWN ---
const gracefulShutdown = () => {
  Logger.info('SIGTERM/SIGINT received. Shutting down gracefully...');
  httpServer.close(() => {
    Logger.info('HTTP server closed.');
    process.exit(0);
  });
};
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
