import jwt from "jsonwebtoken";
import prisma from "../util/prisma.js";
import redisConnection from "../util/redis.js";


const JWT_SECRET = process.env.JWT_SECRET;
const USER_CACHE_TTL_SECONDS = 60;
const userCacheKey = (id) => `auth:user:${id}`;

/**
 * Reads a cached user record from Redis.
 * @param {string|number} id - User id used to build the cache key.
 * @returns {Promise<object|null>} Parsed user object, or null on cache miss/error.
 */
const getCachedUser = async (id) => {
  try {
    const cached = await redisConnection.get(userCacheKey(id));
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.error("Auth cache read error:", error);
    return null;
  }
};

/**
 * Writes a user record to Redis with a fixed TTL.
 * @param {string|number} id - User id used to build the cache key.
 * @param {object} user - User object (with profiles included) to cache.
 * @returns {Promise<void>}
 */
const setCachedUser = async (id, user) => {
  try {
    await redisConnection.set(
      userCacheKey(id),
      JSON.stringify(user),
      "EX",
      USER_CACHE_TTL_SECONDS
    );
  } catch (error) {
    console.error("Auth cache write error:", error);
  }
};

/**
 * Deletes a user's cached record from Redis, forcing the next request to hit the DB.
 * @param {string|number} id - User id whose cache entry should be invalidated.
 * @returns {Promise<void>}
 */
export const invalidateUserCache = async (id) => {
  try {
    await redisConnection.del(userCacheKey(id));
  } catch (error) {
    console.error("Auth cache invalidate error:", error);
  }
};

/**
 * Express middleware that authenticates a request via Bearer JWT, checking a
 * DB-backed token blacklist and a Redis-backed user cache before falling
 * back to the database, then attaches the resolved user to req.user.
 * @param {import('express').Request} req - Incoming request; reads req.headers.authorization.
 * @param {import('express').Response} res - Used to short-circuit with 401/403 on auth failure.
 * @param {import('express').NextFunction} next - Called on successful authentication.
 * @returns {Promise<void>}
 */
export const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];

      //check if token is blacklisted (added during logout)

      const blacklisted = await prisma.blacklistedToken.findUnique({
        where: { token },
      });

      if (blacklisted) {
        return res.status(401).json({ message: "Token has been logged out" });
      }

      const decoded = jwt.verify(token, JWT_SECRET);

      req.user = await getCachedUser(decoded.id);

      if (!req.user) {
        req.user = await prisma.user.findUnique({
          where: { id: decoded.id },
          include: { userProfile: true, vendorProfile: true },
        });

        if (req.user) {
          await setCachedUser(decoded.id, req.user);
        }
      }

            if (!req.user) {
                return res.status(401).json({ message: 'Not authorized, user not found' });
            }

            // Check for activity if needed (can be separate middleware but good safety net)
            if (req.user.is_active === false) {
                 return res.status(403).json({ message: 'Account is inactive' });
            }

            if (req.user.is_verified === false) {
                 const hasProfile = req.user.userProfile || req.user.vendorProfile;
                 if (hasProfile) {
                     // Auto-verify legacy accounts that already have a profile
                     await prisma.user.update({
                         where: { id: req.user.id },
                         data: { is_verified: true }
                     });
                     req.user.is_verified = true;
                     await invalidateUserCache(req.user.id);
                 } else {
                     return res.status(403).json({ message: 'Account not verified' });
                 }
            }

      next();
    } catch (error) {
      console.error('Auth Middleware Error:', error);
      const message =
        error.message === "Not authorized, user not found" ||
        error.message === "Account is inactive"
          ? error.message
          : "Not authorized, token failed";
      return res.status(401).json({ message });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};
