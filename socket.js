// socket.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { allowedOrigins } from "./util/cors.js";
import Logger from "./util/logger.js";
import prisma from "./util/prisma.js";

const JWT_SECRET = process.env.JWT_SECRET;

let io;

/**
 * `join_room` had no auth at all: any connected client could emit
 * `join_room` with an arbitrary string and receive everything broadcast to
 * that room afterward -- read another user's booking updates, or another
 * conversation's chat messages, just by guessing/incrementing an id. Fixing
 * the HTTP IDOR endpoints and leaving this open would have left the exact
 * same data reachable through the socket instead.
 *
 * Two room shapes exist in this codebase (see every `io.to(...)` call across
 * controllers/ and workers/) and each needs its own membership check:
 *   - `user_${id}` / `vendor_${id}` -- personal rooms. Only the
 *     authenticated user with that id may join their own.
 *   - a bare numeric conversation id -- chat rooms. Only a participant in
 *     that conversation's booking (the customer or the vendor) may join.
 */
const isOwnPersonalRoom = (room, authUser) => {
  const m = /^(?:user|vendor)_(\d+)$/.exec(room);
  if (!m) return false;
  return Number(m[1]) === authUser.id;
};

const isConversationParticipant = async (room, authUser) => {
  if (!/^\d+$/.test(room)) return false;

  const conversation = await prisma.conversation.findUnique({
    where: { id: Number(room) },
    select: {
      booking: { select: { userId: true, service: { select: { vendorId: true } } } },
    },
  });
  if (!conversation) return false;

  return (
    conversation.booking.userId === authUser.id ||
    conversation.booking.service?.vendorId === authUser.id
  );
};

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60000,
  });

  // Same JWT every HTTP request already carries (middleware/authMiddleware.js
  // `protect`), sent once at connection time via `io(url, { auth: { token } })`
  // rather than per-event -- socket.io keeps the handshake result attached to
  // the connection for its lifetime. A connection with no or invalid token is
  // refused outright; there is no "connect anonymously, downgrade later" path,
  // since every current use of this socket (booking rooms, chat rooms) requires
  // an identified user.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication required"));

      const decoded = jwt.verify(token, JWT_SECRET);
      // Same cross-table token-confusion guard as authMiddleware.js `protect`
      // — without it, an admin access token or a 30-day refresh token
      // (signed with the same JWT_SECRET) authenticates a socket connection
      // as whichever User row happens to share the token's `id` claim.
      if (decoded.type !== "access") {
        return next(new Error("Authentication required"));
      }
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, role: true, is_active: true },
      });
      if (!user || user.is_active === false) {
        return next(new Error("Authentication required"));
      }

      socket.authUser = user;
      next();
    } catch (err) {
      next(new Error("Authentication required"));
    }
  });

  io.on("connection", (socket) => {
    Logger.debug(`[Socket] Client connected: ${socket.id} (user ${socket.authUser.id})`);

    socket.on("join_room", async (room) => {
      try {
        const roomKey = String(room);
        const allowed =
          isOwnPersonalRoom(roomKey, socket.authUser) ||
          (await isConversationParticipant(roomKey, socket.authUser));

        if (!allowed) {
          Logger.warn(
            `[Socket] user ${socket.authUser.id} denied join to room "${roomKey}"`
          );
          return;
        }

        socket.join(roomKey);
        Logger.debug(`[Socket] ${socket.id} joined room: ${roomKey}`);
      } catch (err) {
        Logger.error(`[Socket] join_room error for user ${socket.authUser.id}:`, err);
      }
    });

    socket.on("disconnect", () => {
      Logger.debug(`[Socket] Client disconnected: ${socket.id}`);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
};
