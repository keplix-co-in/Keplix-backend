import 'dotenv/config';
import { env } from "./config/env.js";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";

import { notFound, errorHandler } from "./middleware/errorMiddleware.js";
import loggerMiddleware from "./middleware/loggerMiddleware.js";
import corsOptions, { allowedOrigins } from "./util/cors.js";
import Logger from "./util/logger.js";
import prisma from "./util/prisma.js";
import redisConnection from "./util/redis.js";
import swaggerSpec from "./config/swagger.js";

// Auth
import authRoutes, { logoutRouter } from "./routes/auth.js";

// Vendor
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

// User
import userProfileRoutes from "./routes/user/profile.js";
import userServiceRoutes from "./routes/user/services.js";
import userBookingRoutes from "./routes/user/bookings.js";
import userPaymentRoutes from "./routes/user/payments.js";
import userInteractionRoutes from "./routes/user/interactions.js";
import userNotificationRoutes from "./routes/user/notifications.js";
import reviewRoutes from "./routes/user/reviews.js";
import feedbackRoutes from "./routes/user/feedback.js";

// Admin
import authAdminRoutes from "./routes/Admin/authAdmin.js";
import dashBoardRoutes from "./routes/Admin/dashBoard.js";
import adminBookingRoutes from "./routes/Admin/bookings.js";
import adminUserRoutes from "./routes/Admin/user.js";
import adminVendorRoutes from "./routes/Admin/vendor.js";
import adminFinanceRoutes from "./routes/Admin/finance.js";
import adminBlogRoutes from "./routes/Admin/blog.js";
import publicBlogRoutes from "./routes/public/blog.js";

/**
 * The Express application: middleware, routes and error handling only.
 *
 * Deliberately does NOT listen, start BullMQ workers, schedule cron jobs or
 * initialise Socket.IO — those live in server.js. Keeping them out means this
 * module can be imported by tests (supertest) without booting queues, timers
 * and a port binding that would then have to be torn down. server.js is the
 * only process entrypoint.
 *
 * Socket.IO needs the http server, so server.js sets `app.set("io", io)` after
 * creating it. Every consumer reads it defensively via `req.app.get("io")` and
 * skips emitting when absent, so the app works without it under test.
 */
const app = express();

// If env invalid → this module will have already crashed at the config import
// above, with detailed Zod error logs.
Logger.info("Environment variables validated successfully");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  max: env.NODE_ENV === 'production' ? 20 : 50,
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
// POST /service_api/vendor/payout was removed — it called the gateway
// synchronously and bypassed both the PayoutSettlement idempotency ledger and
// the BullMQ queue that /admin/finance/payouts/:id/settle uses, making it a
// second, independent path to the same RazorpayX transfer with none of the
// same protections. Admin payout settlement now has exactly one route.
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
app.use("/admin", adminBlogRoutes);

// Public content (no auth) — consumed by the marketing site
app.use("/content", publicBlogRoutes);

// --- ERROR HANDLING ---
app.use(notFound);
app.use(errorHandler);

export default app;
