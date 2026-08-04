import 'dotenv/config';
import { env } from "./config/env.js"; 
import express from "express";
import cors from "cors";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";

// Local Imports
import { initSocket } from "./socket.js";
import { notFound, errorHandler } from "./middleware/errorMiddleware.js";
import loggerMiddleware from "./middleware/loggerMiddleware.js";
import corsOptions, { allowedOrigins } from "./util/cors.js";
import Logger from "./util/logger.js";
import prisma from "./util/prisma.js";
import redisConnection from "./util/redis.js";
import bookingStatusManager from "./util/bookingStatusManager.js";
import swaggerSpec from "./config/swagger.js";
import notificationWorker from "./workers/notificationWorker.js";
import payoutWorker from "./workers/payoutWorker.js";
import otpCleanupWorker from "./workers/otpCleanupWorker.js";
import { scheduleOtpCleanup } from "./queues/otpCleanupQueue.js";

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
import vendorPayoutRoutes from "./routes/vendor/vendorPayout.js";

// User Routes
import userProfileRoutes from "./routes/user/profile.js";
import userServiceRoutes from "./routes/user/services.js";
import userBookingRoutes from "./routes/user/bookings.js";
import userPaymentRoutes from "./routes/user/payments.js";
import userInteractionRoutes from "./routes/user/interactions.js";
import userNotificationRoutes from "./routes/user/notifications.js";
import reviewRoutes from "./routes/user/reviews.js";
import feedbackRoutes from "./routes/user/feedback.js";
import { protect } from "./middleware/authMiddleware.js";

// Admin Routes
import authAdminRoutes from "./routes/Admin/authAdmin.js";
import dashBoardRoutes from "./routes/Admin/dashBoard.js";
import adminBookingRoutes from "./routes/Admin/bookings.js";
import adminUserRoutes from "./routes/Admin/user.js";
import adminVendorRoutes from "./routes/Admin/vendor.js";
import adminFinanceRoutes from "./routes/Admin/finance.js";

// --- CONFIGURATION ---

const app = express();
const httpServer = createServer(app);

// If env invalid → server will crash here with detailed error logs from Zod
Logger.info("Environment variables validated successfully");

// Path setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Socket.IO
const io = initSocket(httpServer);
app.set("io", io);

// --- RATE LIMITERS ---
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." }
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === 'production' ? 20 : 50, // ✅ env use
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many authentication attempts, please try again in a few minutes." },
  skip: (req) => req.path.includes('/logout') || req.path.includes('/token/refresh')
});

// --- BODY PARSER ---
// verify callback stashes the raw bytes so webhook signature checks (e.g. Razorpay)
// can HMAC the exact payload instead of a re-serialized JSON.stringify(req.body)
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- MIDDLEWARE ---
app.use(loggerMiddleware);
app.use(helmet());
app.use(helmet.frameguard({ action: "deny" }));
app.use(compression());

// CSP
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", ...allowedOrigins],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  })
);

// CORS
app.use(cors(corsOptions));

// Static
app.use("/media", express.static(path.join(__dirname, "media")));

// --- HEALTH CHECK ---
// Actually pings the DB and Redis rather than just checking the client
// objects were constructed, so a downed Supabase/Redis instance causes
// Cloud Run to see this as unhealthy instead of reporting "healthy" while
// every real request fails.
app.get('/health', async (req, res) => {
  const checks = { database: 'unknown', redis: 'unknown' };
  let healthy = true;

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    checks.database = 'ok';
  } catch (error) {
    checks.database = 'unreachable';
    healthy = false;
  }

  try {
    await Promise.race([
      redisConnection.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    checks.redis = 'ok';
  } catch (error) {
    checks.redis = 'unreachable';
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: env.NODE_ENV,
    checks
  });
});

// Swagger
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Global rate limiter
app.use(limiter);

// --- ROUTES ---

// Auth
app.use("/accounts/auth", authLimiter, authRoutes);
app.use("/accounts/auth", logoutRouter);

// Vendor
app.use("/accounts/vendor", vendorProfileRoutes);
app.use("/accounts/documents", documentRoutes);
app.use("/service_api/vendor", vendorServiceRoutes);
app.use("/service_api/vendor", vendorBookingRoutes);
app.use("/service_api/vendor", vendorPayoutRoutes);
app.use("/service_api", inventoryRoutes);
app.use("/service_api", availabilityRoutes);
app.use("/interactions/vendors", promotionRoutes);
app.use("/interactions/api/vendor", vendorReviewRoutes);
app.use("/interactions/api/vendor", vendorFeedbackRoutes);
app.use("/interactions/api/vendor", vendorInteractionRoutes);
app.use("/interactions/api/vendor", vendorNotificationRoutes);

// User
app.use("/service_api/user", userServiceRoutes);
app.use("/service_api/user", userBookingRoutes);
app.use("/service_api/user", userProfileRoutes);

// Shared
app.use("/service_api", userServiceRoutes);
app.use("/service_api", userPaymentRoutes);
app.use("/service_api", vendorPaymentRoutes);

// Interactions
app.use("/interactions/api/user", userInteractionRoutes);
app.use("/interactions/api/user/notifications", userNotificationRoutes);
app.use("/interactions/api/feedback", feedbackRoutes);
app.use("/interactions/api", reviewRoutes);

// Admin
app.use("/admin/auth", authAdminRoutes);
app.use("/admin", dashBoardRoutes);
app.use("/admin", adminBookingRoutes);
app.use("/admin", adminUserRoutes);
app.use("/admin", adminVendorRoutes);
app.use("/admin", adminFinanceRoutes);

// --- ERROR HANDLING ---
app.use(notFound);
app.use(errorHandler);

// --- SERVER START ---
const PORT = env.PORT || 8080;

httpServer.listen(PORT, '0.0.0.0', () => {
  Logger.info(`=================================`);
  Logger.info(`🚀 Keplix Backend Running`);
  Logger.info(`🌍 URL: http://0.0.0.0:${PORT}`);
  Logger.info(`⚙️ Mode: ${env.NODE_ENV}`);
  Logger.info(`=================================`);

  bookingStatusManager.start();
  scheduleOtpCleanup().catch((err) => Logger.error('Failed to schedule OTP cleanup job:', err));
});

// --- GRACEFUL SHUTDOWN ---
const gracefulShutdown = () => {
  Logger.info('SIGTERM/SIGINT received. Shutting down gracefully...');

  bookingStatusManager.stop();

  if (notificationWorker) {
    notificationWorker.close().then(() => {
      Logger.info('Notification worker closed.');
    }).catch(err => {
      Logger.error('Error closing notification worker:', err);
    });
  }

  if (payoutWorker) {
    payoutWorker.close().then(() => {
      Logger.info('Payout worker closed.');
    }).catch(err => {
      Logger.error('Error closing payout worker:', err);
    });
  }

  if (otpCleanupWorker) {
    otpCleanupWorker.close().then(() => {
      Logger.info('OTP cleanup worker closed.');
    }).catch(err => {
      Logger.error('Error closing OTP cleanup worker:', err);
    });
  }

  httpServer.close(() => {
    Logger.info('HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  Logger.error('Uncaught Exception:', error);
});