import IORedis from "ioredis";
import { env } from "../config/env.js";

const redisConnection = new IORedis({
  host: env.REDIS_HOST,
  port: parseInt(env.REDIS_PORT),
  password: env.REDIS_PASSWORD,
  ...(env.REDIS_TLS === "true" ? { tls: {} } : {}),
  maxRetriesPerRequest: null, // Required by BullMQ
});

// Without a listener, ioredis connection errors become unhandled exceptions.
redisConnection.on("error", (err) => {
  console.error("[Redis] connection error:", err.message);
});

export default redisConnection;
