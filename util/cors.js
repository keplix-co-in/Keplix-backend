import dotenv from "dotenv";
import Logger from "./logger.js";
dotenv.config();

// Fail closed: only relax CORS when explicitly running in development, not
// merely "whenever NODE_ENV isn't 'production'" (e.g. if it's unset).
const isDev = process.env.NODE_ENV === "development";

// Security A-010 / SYS-006: the list used to end with /\.vercel\.app$/, and
// the callback also accepted any https://<x>.vercel.app. Anyone can deploy a
// project to *.vercel.app in a minute, and with credentials: true that let an
// attacker's page make authenticated, readable API calls from a victim's
// browser. Production front ends all live on keplix.co.in (covered by the
// anchored subdomain rule below). To allow one specific extra origin (a
// preview build, say) set ALLOWED_ORIGINS to a comma-separated list of exact
// origins -- no wildcards.
export const parseAllowedOriginsEnv = (raw) =>
  String(raw || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => /^https?:\/\/[^\s/]+$/i.test(o));

const allowedOrigins = [
  'https://admin.keplix.co.in',
  'https://keplix.co.in',
  'http://localhost:8000',
  'http://localhost:5173', // <-- Add this line for the Admin local dev
  'http://localhost:5174', // <-- Optional: if you run the website locally too
  'http://localhost:3000', // vendor web portal (keplix-webpage-vendors) local dev
  ...parseAllowedOriginsEnv(process.env.ALLOWED_ORIGINS),
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
    
    // Always allow keplix.co.in and its subdomains (anchored, not substring).
    // Security A-010: the *.vercel.app rule that sat here is gone (see above).
    const keplixSubdomain = /^https:\/\/([a-z0-9-]+\.)*keplix\.co\.in$/i;
    if (keplixSubdomain.test(origin)) {
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
