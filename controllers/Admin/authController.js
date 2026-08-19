import prisma from '../../util/prisma.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
<<<<<<< HEAD
const JWT_SECRET = process.env.JWT_SECRET;

const generateToken = (user) => {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
    expiresIn: "30d",
  });
};

=======
import crypto from 'crypto';

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

/**
 * generateAccessToken
 * Creates a short-lived JWT used to authenticate protected API requests.
 *
 * @param {{ id: number, role: string }} user - Admin record fields required for the token payload.
 * @returns {string} Signed JWT valid for 15 minutes.
 */
const generateAccessToken = (user) => {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
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
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
export const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.admin.findUnique({ where: { email } });

    if (!user) {
<<<<<<< HEAD
      return res.status(404).json({ message: "Admin not found" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if(!isPasswordValid){
      return res.status(401).json({ message: "Invalid password" });
    };

    const userData = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    };

    res.json({
      user: userData,
      token: generateToken(user),
      refresh: generateToken(user),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};


=======
      return res.status(404).json({ message: 'Admin not found' });
    }

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ message: 'Account is not active' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid password' });
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

    return res.json({ message: 'Logged out successfully' });
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
  }
};
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
