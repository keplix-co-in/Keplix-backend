const isProd = process.env.NODE_ENV === "production";

// Read allowed origins from env (comma separated)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : [];

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
    if (!isProd) {
      return callback(null, true);
    }

    //Production Mode → Allow only whitelisted origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    //Block everything else
    return callback(
      new Error(`CORS blocked for origin: ${origin}`),
      false
    );
  },

  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

export default corsOptions;
