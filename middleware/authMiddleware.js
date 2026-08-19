import jwt from "jsonwebtoken";
import prisma from "../util/prisma.js";


const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Marks a JWT as logged out, until it would naturally expire.
 *
 * This was a Redis SET with an EX ttl. It is now a row in BlacklistedToken --
 * a model that already existed in the schema, unused. Redis was removed
 * outright (see util/jobQueue.js for the full reasoning); the one capability
 * genuinely lost is Redis expiring these rows for us, so the hourly cron in
 * queues/otpCleanupQueue.js prunes them instead.
 *
 * A token past its own `exp` needs no row at all: jwt.verify rejects it on
 * signature expiry regardless of what this table says.
 *
 * @param {string} token - Raw JWT string to blacklist.
 * @param {number} expUnixSeconds - Token's `exp` claim (Unix seconds).
 * @returns {Promise<void>}
 */
export const blacklistToken = async (token, expUnixSeconds) => {
  const ttlSeconds = Math.max(expUnixSeconds - Math.floor(Date.now() / 1000), 0);
  if (ttlSeconds === 0) return;

  try {
    // upsert, not create: logging out twice with the same token must not throw
    // on the unique constraint.
    await prisma.blacklistedToken.upsert({
      where: { token },
      update: { expiresAt: new Date(expUnixSeconds * 1000) },
      create: { token, expiresAt: new Date(expUnixSeconds * 1000) },
    });
  } catch (error) {
    console.error("Auth blacklist write error:", error);
  }
};

/**
 * Checks whether a JWT has been blacklisted (e.g. via logout).
 *
 * Fails CLOSED, and that is no longer the liability it was. When this lived in
 * Redis, failing closed meant an unrelated cache outage 401'd every
 * authenticated request in both apps -- which is exactly what happened when the
 * hosted Redis quota ran out. The check now runs against Postgres, the same
 * database the very next line of this middleware must query to load the user.
 * There is no partial-failure mode left to protect against: if this query
 * cannot run, nothing downstream could have served the request anyway.
 *
 * @param {string} token - Raw JWT string to check.
 * @returns {Promise<boolean>} True if blacklisted, or if the lookup errored.
 */
const isTokenBlacklisted = async (token) => {
  try {
    const row = await prisma.blacklistedToken.findUnique({
      where: { token },
      select: { id: true },
    });
    return row !== null;
  } catch (error) {
    console.error("Auth blacklist read error:", error);
    return true;
  }
};

/**
 * Checks whether a refresh token has been blacklisted (e.g. by a prior
 * rotation or logout).
 * @param {string} token - Raw refresh JWT string to check.
 * @returns {Promise<boolean>} True if blacklisted or if the lookup errored.
 */
export const isRefreshTokenBlacklisted = isTokenBlacklisted;

/**
 * No-op retained for API compatibility.
 *
 * The 60-second Redis user cache this used to invalidate is gone along with
 * Redis. `protect` now reads the user straight from Postgres on every request,
 * which is a query it already made on every cache miss. Callers are left in
 * place so that reintroducing a cache later has an obvious seam, and so this
 * change does not ripple into unrelated call sites.
 *
 * @param {string|number} _id - Ignored.
 * @returns {Promise<void>}
 */
export const invalidateUserCache = async (_id) => {
  // Intentionally empty: there is no cache to invalidate.
};

/**
 * Express middleware that authenticates a request via Bearer JWT, checking a
 * Redis-backed token blacklist and a Redis-backed user cache before falling
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

      const blacklisted = await isTokenBlacklisted(token);

      if (blacklisted) {
        return res.status(401).json({ message: "Token has been logged out" });
      }

      const decoded = jwt.verify(token, JWT_SECRET);

      // Straight to Postgres. The 60s Redis cache that used to sit in front of
      // this is gone; this is the same query that ran on every cache miss.
      req.user = await prisma.user.findUnique({
        where: { id: decoded.id },
        include: { userProfile: true, vendorProfile: true },
      });

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

