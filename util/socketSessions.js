import crypto from 'crypto';
// Security SYS-002 / A-028: tear down a user's live Socket.IO connections.
//
// Revoking a JWT (logout, password change, account erasure) stopped new HTTP
// requests, but a socket authenticates once at handshake and then stays open,
// so a logged-out device kept receiving booking, payment and chat events.
//
// Rooms covered:
//   session_<id> -- joined server-side for every authenticated socket (socket.js)
//   user_<id>, vendor_<id> -- the personal rooms clients join themselves
// Both personal rooms are always included: the vendor_ room can only ever be
// joined by that same user id (socket.js isOwnPersonalRoom), so disconnecting
// it for a non-vendor is a harmless no-op and avoids a role lookup here.

export const sessionRoom = (userId) => `session_${userId}`;

// Review fix: logout revokes ONE token, but disconnectUserSockets dropped every
// device's socket for that user -- logging out of the web portal killed the
// vendor app's live booking/chat socket too, and socket.io-client does not
// auto-reconnect after a server-side disconnect. Each socket also joins a room
// keyed by a hash of the token it authenticated with, so logout can drop only
// the sockets opened with the token it just revoked. (Password change and
// erasure still drop everything: every token is dead then.)
export const tokenRoom = (token) =>
  `token_${crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32)}`;

/** Disconnect only the sockets that authenticated with `token`. */
export const disconnectTokenSockets = (io, token) => {
  if (!io || !token) return false;
  try {
    io.in(tokenRoom(token)).disconnectSockets(true);
    return true;
  } catch (err) {
    console.error('disconnectTokenSockets failed:', err);
    return false;
  }
};

/**
 * @param {import('socket.io').Server | undefined | null} io
 * @param {number} userId
 * @returns {boolean} true when a disconnect was issued.
 */
export const disconnectUserSockets = (io, userId) => {
  if (!io || userId === undefined || userId === null) return false;
  try {
    io.in([sessionRoom(userId), `user_${userId}`, `vendor_${userId}`]).disconnectSockets(true);
    return true;
  } catch (err) {
    // Never fail a logout because the socket layer is unhappy.
    console.error('disconnectUserSockets failed:', err);
    return false;
  }
};
