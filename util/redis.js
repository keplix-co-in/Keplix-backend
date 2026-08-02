import IORedis from "ioredis";
import { env } from "../config/env.js";

const redisConnection = new IORedis({
  host: env.REDIS_HOST,
  port: parseInt(env.REDIS_PORT),
  maxRetriesPerRequest: null, // Required by BullMQ
});

export default redisConnection;
