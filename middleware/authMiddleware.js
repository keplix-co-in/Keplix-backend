import prisma from "../util/prisma.js";
import { verifySupabaseToken, fetchSupabaseUser } from "../util/supabaseAuth.js";

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
// Security A-007: longest lifetime any token we issue can have (refresh tokens
// are 30d). A blacklist row never needs to outlive that, so an `exp` claim
// further out than this is clamped rather than trusted.
export const MAX_BLACKLIST_TTL_SECONDS = 30 * 24 * 60 * 60;

export const blacklistToken = async (token, expUnixSeconds) => {
  if (typeof token !== 'string' || !token || !Number.isFinite(expUnixSeconds)) return;
  const nowSeconds = Math.floor(Date.now() / 1000);
  expUnixSeconds = Math.min(expUnixSeconds, nowSeconds + MAX_BLACKLIST_TTL_SECONDS);
  const ttlSeconds = Math.max(expUnixSeconds - nowSeconds, 0);
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
 * Finds the Prisma row (User or Admin) a Supabase session belongs to.
 *
 * 1. By supabaseId -- the normal path once an account has signed in once (or
 *    was linked by scripts/importUsersToSupabase.js).
 * 2. Otherwise by email, but only after the Supabase Admin API confirms that
 *    email is verified. The token's email claim alone is not proof: linking
 *    on an unverified address would hand an existing account to whoever
 *    signed up with it. The link is then saved, so this runs once per row.
 *
 * A row already linked to a DIFFERENT Supabase user is never re-linked.
 *
 * @param {object} delegate - prisma.user or prisma.admin
 * @param {{sub: string, email: string|null}} claims
 * @param {object} [query] - extra findFirst args (include/select)
 * @returns {Promise<object|null>}
 */
// Audit 2026-11-07 (HIGH, account takeover): email-linking is opt-out via
// `allowEmailLink: false`. authAdmin passes false -- an Admin row must already
// carry supabaseId (set by scripts/importUsersToSupabase.js, or by hand for a
// new admin), so no Supabase sign-up, however verified, can ever claim an
// admin by email.
//
// For User rows email-linking stays (it is how the 50 pre-migration accounts
// sign in the first time), but ONLY after the Supabase Admin API (server-side,
// secret key) re-reads the user and confirms email_confirmed_at -- the token's
// own email/email_verified claims are never trusted. That rule already covers
// role 'vendor' rows (payout bank details live behind them). Any other,
// unexpected role in the User table (anything but user/vendor) is treated as
// privileged and is never email-linked at all.
const EMAIL_LINKABLE_USER_ROLES = new Set(["user", "vendor"]);

export const findAccountForSupabaseClaims = async (delegate, claims, query = {}, { allowEmailLink = true } = {}) => {
  const linked = await delegate.findFirst({ where: { supabaseId: claims.sub }, ...query });
  if (linked) return linked;
  if (!allowEmailLink || !claims.email) return null;

  const byEmail = await delegate.findFirst({
    where: { email: { equals: claims.email, mode: "insensitive" } },
    ...query,
  });
  if (!byEmail) return null;

  const current = await delegate.findUnique({
    where: { id: byEmail.id },
    select: { supabaseId: true, role: true },
  });
  if (current?.supabaseId && current.supabaseId !== claims.sub) return null;
  // See EMAIL_LINKABLE_USER_ROLES above. `current.role` is read fresh rather
  // than from byEmail, whose shape depends on the caller's select.
  if (current?.role !== undefined && !EMAIL_LINKABLE_USER_ROLES.has(current.role)) return null;

  const supaUser = await fetchSupabaseUser(claims.sub);
  if (!supaUser?.email_confirmed_at || String(supaUser.email || "").toLowerCase() !== claims.email) {
    return null;
  }

  await delegate.update({ where: { id: byEmail.id }, data: { supabaseId: claims.sub } });
  return byEmail;
};

/** True when a token's `iat` (seconds) predates passwordChangedAt. */
export const isIssuedBeforePasswordChange = (iat, passwordChangedAt) => {
  if (!passwordChangedAt || !Number.isFinite(iat)) return false;
  const changed = new Date(passwordChangedAt).getTime();
  if (!Number.isFinite(changed)) return false;
  return iat < Math.floor(changed / 1000);
};

/** Reads the Bearer token from a request, or null. */
const bearerToken = (req) => {
  const header = req.headers?.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
};

/**
 * Checks a Supabase access token and loads the matching Prisma User (with
 * profiles). Shared by `protect` and the Socket.IO handshake.
 *
 * @returns {Promise<{user?: object, status?: number, message?: string}>}
 */
export const authenticateSupabaseUser = async (token, query = { include: { userProfile: true, vendorProfile: true } }) => {
  let claims;
  try {
    claims = await verifySupabaseToken(token);
  } catch {
    return { status: 401, message: "Not authorized, token failed" };
  }

  const user = await findAccountForSupabaseClaims(prisma.user, claims, query);
  if (!user) return { status: 401, message: "Not authorized, user not found", claims };
  if (user.is_active === false) return { status: 403, message: "Account is inactive" };
  // Audit 2026-11-07 (revocation gap): restored for Supabase tokens. A
  // password change stamps passwordChangedAt; any access token minted before
  // it is refused even though Supabase would still honour it until `exp`.
  // Compared in whole seconds (iat is floored) so a token issued in the same
  // second as the change is not wrongly refused.
  if (isIssuedBeforePasswordChange(claims.iat, user.passwordChangedAt)) {
    return { status: 401, message: "Not authorized, password changed" };
  }
  return { user, claims };
};

/**
 * Express middleware: authenticates a request by its Supabase access token
 * and attaches the Prisma user (with userProfile/vendorProfile) to req.user.
 *
 * Supabase-only since the 2026-11 migration. Tokens signed with the old
 * JWT_SECRET are no longer accepted anywhere; revocation (logout, password
 * change) is handled by Supabase ending the session; the passwordChangedAt
 * check is kept (see authenticateSupabaseUser) to close the window until a
 * stolen access token's `exp`.
 */
export const protect = async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  try {
    const result = await authenticateSupabaseUser(token);
    if (!result.user) {
      return res.status(result.status).json({ message: result.message });
    }
    req.user = result.user;
    req.supabaseClaims = result.claims;

    if (req.user.is_verified === false) {
      // Supabase only issues a session after the email is confirmed (or for a
      // Google account), so a signed-in user is verified by definition.
      await prisma.user.update({ where: { id: req.user.id }, data: { is_verified: true } });
      req.user.is_verified = true;
    }

    return next();
  } catch (error) {
    console.error("Auth Middleware Error:", error);
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
};

/**
 * Express middleware for routes that run BEFORE a Prisma user exists (only
 * POST /accounts/auth/supabase/sync): verifies the Supabase token and sets
 * req.supabaseClaims, without requiring a matching row.
 */
export const requireSupabaseSession = async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ message: "Not authorized, no token" });
  try {
    req.supabaseClaims = await verifySupabaseToken(token);
    return next();
  } catch {
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
};
