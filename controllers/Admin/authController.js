import prisma from '../../util/prisma.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { blacklistToken } from '../../middleware/authMiddleware.js';

/**
 * Hash a refresh token for storage.
 *
 * SHA-256, NOT bcrypt. bcrypt silently truncates its input at 72 bytes, and a
 * refresh token here is a ~157-byte JWT whose first 72 bytes are just the
 * header plus the opening of the payload — `iat`, `exp` and the whole
 * signature all sit beyond the cutoff. Every token ever issued to a given
 * admin therefore shared a bcrypt hash, which meant:
 *   - rotation was cosmetic: a superseded token still verified;
 *   - reuse detection could never fire;
 *   - a stolen refresh token stayed valid for its full 7 days, and revoking it
 *     by rotating was impossible.
 *
 * bcrypt's cost is there to slow brute force against low-entropy PASSWORDS. A
 * signed 157-byte JWT is already high-entropy and unguessable, so a fast hash
 * is the right tool — and unlike bcrypt it reads the entire input.
 */
const hashRefreshToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

/** Constant-time compare, so verification can't be timed to recover the hash. */
const refreshTokenMatches = (token, stored) => {
  if (!stored) return false;
  const a = Buffer.from(hashRefreshToken(token), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

// A precomputed bcrypt hash with no known plaintext, compared against on the
// admin-not-found branch of login() below so that branch takes the same time
// as a real password check -- otherwise "no such admin" resolves faster than
// "wrong password" and an attacker can enumerate valid admin emails purely
// from response timing, even with the response body itself unified.
const DUMMY_PASSWORD_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8Z2vRuAV9AGqzu27Bg9G/uc7Q8jVIm';

/**
 * generateAccessToken
 * Creates a short-lived JWT used to authenticate protected API requests.
 *
 * @param {{ id: number, role: string }} user - Admin record fields required for the token payload.
 * @returns {string} Signed JWT valid for 15 minutes.
 */
const generateAccessToken = (user) => {
  // `type: 'admin_access'` is load-bearing, not decorative: User and Admin are
  // separate tables with overlapping autoincrement ids, and both token
  // families are signed with the same JWT_SECRET. Without this claim,
  // authAdminMiddleware verifies the signature, looks decoded.id up in
  // Admin, and finds a match whenever a customer's User.id happens to equal
  // an existing Admin.id — full admin takeover with an ordinary login token.
  // authMiddleware.protect checks the mirror-image `type !== 'access'` guard.
  return jwt.sign({ id: user.id, role: user.role, type: 'admin_access' }, JWT_SECRET, {
    expiresIn: '15m',
  });
};

/**
 * generateRefreshToken
 * Creates a long-lived JWT used exclusively to obtain new access tokens.
 * Signed with a separate secret so a leaked access-token secret cannot be
 * used to forge refresh tokens.
 *
 * @param {{ id: number, role: string }} user - Admin record fields required for the token payload.
 * @returns {string} Signed JWT valid for 7 days.
 */
const generateRefreshToken = (user) => {
  return jwt.sign({ id: user.id, role: user.role }, JWT_REFRESH_SECRET, {
    expiresIn: '7d',
  });
};

/**
 * login
 * Authenticates an admin with email + password. On success it issues a
 * short-lived access token (15 min) and a long-lived refresh token (7 days).
 * The refresh token is stored as a SHA-256 hash in the Admin row so it can
 * be verified and rotated on subsequent /refresh calls. See hashRefreshToken
 * for why this is not bcrypt.
 *
 * @param {import('express').Request}  req  - Body: { email: string, password: string }
 * @param {import('express').Response} res  - 200 { user, accessToken, refreshToken }
 *                                           401 invalid password
 *                                           404 admin not found
 *                                           500 server error
 */
export const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.admin.findUnique({ where: { email } });

    // Enumeration fix: unknown-email, wrong-password and suspended-account
    // used to return distinct 404/401/403 responses, letting an attacker
    // enumerate valid admin emails (and which are disabled) before spending
    // any password guesses. Unknown email and wrong password now collapse
    // into one generic response; the dummy-hash compare below keeps their
    // timing indistinguishable too. Account status is checked only AFTER a
    // correct password is confirmed, since revealing "this account exists
    // and is suspended" is safe once the caller has proven they know the
    // password -- it is the pre-auth branches that must not leak.
    const isPasswordValid = await bcrypt.compare(
      password,
      user ? user.password : DUMMY_PASSWORD_HASH
    );

    if (!user || !isPasswordValid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ message: 'Account is not active' });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    const hashedRefreshToken = hashRefreshToken(refreshToken);

    await prisma.admin.update({
      where: { id: user.id },
      data: {
        refreshToken: hashedRefreshToken,
        lastLoginAt: new Date(),
      },
    });

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * refresh
 * Validates the incoming refresh token against the hashed value stored in the
 * database, then performs token rotation: the old refresh token is invalidated
 * and a brand-new access + refresh token pair is issued.  This limits the
 * damage window of a stolen refresh token to a single use.
 *
 * @param {import('express').Request}  req  - Body: { refreshToken: string }
 * @param {import('express').Response} res  - 200 { accessToken, refreshToken }
 *                                           401 missing / invalid / expired token
 *                                           500 server error
 */
export const refresh = async (req, res) => {
  const { refreshToken: token } = req.body;

  if (!token) {
    return res.status(401).json({ message: 'Refresh token required' });
  }

  try {
    const payload = jwt.verify(token, JWT_REFRESH_SECRET);

    const user = await prisma.admin.findUnique({ where: { id: payload.id } });

    if (!user || !user.refreshToken) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    // A hash stored before hashRefreshToken switched to SHA-256 is a bcrypt
    // string and will not match, so those sessions are treated as invalid and
    // the admin logs in once more. That is the intended migration path — the
    // old hashes cannot be verified safely.
    const isValid = refreshTokenMatches(token, user.refreshToken);
    if (!isValid) {
      // Possible token reuse — clear the stored token to force re-login
      await prisma.admin.update({
        where: { id: user.id },
        data: { refreshToken: null },
      });
      return res.status(401).json({ message: 'Refresh token reuse detected. Please log in again.' });
    }

    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);
    const hashedNewRefreshToken = hashRefreshToken(newRefreshToken);

    await prisma.admin.update({
      where: { id: user.id },
      data: { refreshToken: hashedNewRefreshToken },
    });

    return res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Refresh token expired. Please log in again.' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * logout
 * Invalidates the admin session by clearing the stored refresh token hash.
 * After this call, neither the current refresh token nor any derived access
 * token can be rotated — the admin must log in again to obtain new tokens.
 *
 * @param {import('express').Request}  req  - Body: { refreshToken: string }
 * @param {import('express').Response} res  - 200 { message }
 *                                           400 missing refresh token
 *                                           401 invalid token
 *                                           500 server error
 */
export const logout = async (req, res) => {
  const { refreshToken: token } = req.body;

  if (!token) {
    return res.status(400).json({ message: 'Refresh token required' });
  }

  try {
    const payload = jwt.verify(token, JWT_REFRESH_SECRET);

    await prisma.admin.update({
      where: { id: payload.id },
      data: { refreshToken: null },
    });

    // Clearing the refresh token stops future rotations, but the admin's
    // current access token stayed valid until it expired on its own -- up to
    // JWT_EXPIRES_IN worth of continued access after "logout". Blacklist it too.
    const accessToken = req.headers?.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.split(' ')[1]
      : null;
    if (accessToken) {
      const decodedAccess = jwt.decode(accessToken);
      if (decodedAccess?.exp) {
        await blacklistToken(accessToken, decodedAccess.exp);
      }
    }

    return res.json({ message: 'Logged out successfully' });
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
};
