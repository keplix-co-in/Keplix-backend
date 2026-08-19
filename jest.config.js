export default {
  testEnvironment: 'node',
  // Load .env before any test module is imported.
  //
  // config/env.js validates required variables (DATABASE_URL, CLOUDINARY_URL,
  // JWT_SECRET) with Zod at import time, and is pulled in transitively by
  // server.js, util/jobQueue.js and others. Without this, any suite that
  // reached that chain died with a Zod error before running a single
  // assertion — which is exactly
  // how tests/controllers/authController.test.js had been failing.
  setupFiles: ['dotenv/config'],
};
