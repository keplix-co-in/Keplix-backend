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
 * Prisma error codes that mean "this query could not run", as opposed to
 * "this query ran and told us something".
 *
 * P2021 table does not exist   P1001 cannot reach the database
 * P1002 connection timed out   P1017 server closed the connection
 *
 * @see https://www.prisma.io/docs/reference/api-reference/error-reference
 */
const INFRA_ERROR_CODES = new Set(["P2021", "P1001", "P1002", "P1017"]);

/**
 * Checks whether a JWT has been blacklisted (e.g. via logout).
 *
 * Failure handling distinguishes two very different things, because conflating
 * them caused a full production outage:
 *
 *   - The query RAN and the answer is unclear, or failed for any reason we do
 *     not recognise -> fail CLOSED (reject). A revoked token must not slip
 *     through on an ambiguous error.
 *   - The query COULD NOT RUN -- missing table, unreachable database -> fail
 *     OPEN (allow), loudly. We have no evidence this token was revoked, and
 *     rejecting means rejecting EVERY user.
 *
 * The distinction is not hypothetical. When the blacklist moved from Redis into
 * this table, the table did not exist in the deployed databases -- deploys run
 * no Prisma step (see .github/workflows/deploy.yml), so schema changes only ever
 * reached production by hand. Every lookup threw P2021, the old blanket
 * `return true` treated that as "blacklisted", and `protect` 401'd every
 * authenticated request in both apps with "Token has been logged out". Login
 * itself succeeded, so it presented as a total, inexplicable product outage.
 *
 * The cost of failing open here is bounded and narrow: during an infrastructure
 * fault, a token that was explicitly logged out is accepted until its own `exp`.
 * The cost of failing closed is unbounded: the entire product stops. Refresh
 * tokens do NOT get this treatment -- see isRefreshTokenBlacklisted.
 *
 * @param {string} token - Raw JWT string to check.
 * @param {object} [options]
 * @param {boolean} [options.failOpenOnInfraError=true] - Whether an unrunnable
 *   query should allow the request through.
 * @returns {Promise<boolean>} True if blacklisted.
 */
const isTokenBlacklisted = async (token, { failOpenOnInfraError = true } = {}) => {
  try {
    const row = await prisma.blacklistedToken.findUnique({
      where: { token },
      select: { id: true },
    });
    return row !== null;
  } catch (error) {
    console.error("Auth blacklist read error:", error);

    if (failOpenOnInfraError && INFRA_ERROR_CODES.has(error?.code)) {
      console.error(
        `Auth blacklist UNAVAILABLE (${error.code}) — allowing the request rather than ` +
          `rejecting every user. Logout revocation is NOT being enforced until this is fixed. ` +
          `If this is P2021, the BlacklistedToken table is missing: apply ` +
          `prisma/migrations_applied/2026-08-19_redis_removal/001_redis_removal.sql`
      );
      return false;
    }

    return true;
  }
};

/**
 * Checks whether a refresh token has been blacklisted (e.g. by a prior
 * rotation or logout).
 *
 * Fails CLOSED even when the database is unreachable, unlike the access-token
 * path. Refresh tokens live for weeks and rotation is a real security
 * guarantee: accepting one we cannot verify would mint a fresh access token on
 * every refresh for the whole duration of the fault. Access tokens expire on
 * their own; this is the one that must not.
 *
 * @param {string} token - Raw refresh JWT string to check.
 * @returns {Promise<boolean>} True if blacklisted or if the lookup errored.
 */
export const isRefreshTokenBlacklisted = (token) =>
  isTokenBlacklisted(token, { failOpenOnInfraError: false });

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

