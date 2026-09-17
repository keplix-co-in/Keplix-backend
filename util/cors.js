import dotenv from "dotenv";
import Logger from "./logger.js";
dotenv.config();

// Fail closed: only relax CORS when explicitly running in development, not
// merely "whenever NODE_ENV isn't 'production'" (e.g. if it's unset).
const isDev = process.env.NODE_ENV === "development";

// Read allowed origins from env (comma separated) or default for dev
const allowedOrigins = [
  'https://admin.keplix.co.in',
  'https://keplix.co.in',
  'http://localhost:8000',
  'http://localhost:5173', // <-- Add this line for the Admin local dev
  'http://localhost:5174', // <-- Optional: if you run the website locally too
  /\.vercel\.app$/ // allows vercel previews
];

/**
 * CORS Options
 * - DEV  : Allow all origins (fast development)
 * - PROD : Allow only whitelisted domains
 */
const corsOptions = {
  origin: (origin, callback) => {

    //Allow server-to-server, Postman, mobile apps
    if (!origin) {
      return callback(null, true);
    }

    //Development Mode → Allow all
    if (isDev) {
      return callback(null, true);
    }

    //Everything else (production, test, unset/misconfigured) → Allow only whitelisted origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Always allow keplix.co.in subdomains and vercel preview domains (anchored, not substring)
    const keplixSubdomain = /^https:\/\/([a-z0-9-]+\.)*keplix\.co\.in$/i;
    const vercelPreview = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
    if (keplixSubdomain.test(origin) || vercelPreview.test(origin)) {
      return callback(null, true);
    }

    // Block everything else. The origin goes to the server log only -- it
    // used to ride in err.message, which the error handler echoed straight
    // back to the caller as a 500 (audit #173). A blocked CORS request is a
    // client mistake, not a server failure, so this is a 403 with a fixed,
    // generic message instead.
    Logger.warn(`CORS blocked for origin: ${origin}`);
    const err = new Error('Not allowed by CORS');
    err.statusCode = 403;
    err.code = 'CORS_BLOCKED';
    return callback(err, false);
  },

  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
  credentials: true,
};

export { allowedOrigins };
export default corsOptions;
