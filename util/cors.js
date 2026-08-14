import dotenv from "dotenv";
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

    //Block everything else
    return callback(
      new Error(`CORS blocked for origin: ${origin}`),
      false
    );
  },

  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
  credentials: true,
};

export { allowedOrigins };
export default corsOptions;
