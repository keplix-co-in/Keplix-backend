import prisma from '../../util/prisma.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

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
 * The refresh token is stored as a bcrypt hash in the Admin row so it can
 * be verified and rotated on subsequent /refresh calls.
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

    if (!user) {
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
    const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);

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

    const isValid = await bcrypt.compare(token, user.refreshToken);
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
    const hashedNewRefreshToken = await bcrypt.hash(newRefreshToken, 10);

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
