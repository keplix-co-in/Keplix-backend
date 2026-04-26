import dotenv from "dotenv";
dotenv.config();

const isProd = process.env.NODE_ENV === "production";

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
    if (!isProd) {
      return callback(null, true);
    }

    //Production Mode → Allow only whitelisted origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Always allow admin subdomain and vercel branch domains
    if (origin.includes("keplix.co.in") || origin.includes("vercel.app") || origin.includes("localhost")) {
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
