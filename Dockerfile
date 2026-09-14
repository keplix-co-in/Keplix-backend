# Use Node.js LTS version. Not pinned to a specific patch/digest --
# node:20-alpine floats to whatever 20.x/alpine patch is current at build
# time. A full digest pin (FROM node:20-alpine@sha256:<digest>) is the more
# robust fix (2026-09-12 audit, F72) but requires verifying the exact digest
# resolves and builds correctly, which needs registry access this change
# was made without. Left as a floating tag with this note rather than
# guessing a digest that might not actually be current.
FROM node:20-alpine

# tini as PID 1 instead of node directly (2026-09-12 audit, F33): node does
# not reap orphaned child processes or reliably forward signals when it IS
# PID 1, so Cloud Run's SIGTERM on deploy/scale-down could fail to reach the
# process cleanly, and any child process (workers, spawned CLI tools) could
# be left as a zombie. tini does both correctly and is the standard fix for
# exactly this class of container.
RUN apk add --no-cache openssl openssl-dev curl tini

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for prisma CLI)
RUN npm install --legacy-peer-deps

# Copy prisma schema
COPY prisma ./prisma/

# Generate Prisma Client
RUN npx prisma generate

# Prune dev dependencies for production image optimization (optional but recommended)
# RUN npm prune --production

# Copy application code
COPY . .

# util/logger.js writes to ./logs/error.log and ./logs/all.log relative to
# CWD -- created and owned by `node` (the non-root user this image already
# ships, uid 1000) here, before the ownership switch below, so the app can
# still write logs after USER drops root.
RUN mkdir -p logs && chown -R node:node /app

# Run as the image's built-in non-root `node` user, not root (2026-09-12
# audit, F72). No other change needed: everything under /app was just
# chown'd to node:node above, and node:alpine ships this user by default.
USER node

# Expose port 8080 (Cloud Run default)
EXPOSE 8080

# Set environment to production
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:${PORT:-8080}/health || exit 1

# tini as PID 1 (see above), forwarding to the actual start command.
ENTRYPOINT ["/sbin/tini", "--"]

# Start the application
CMD ["node", "server.js"]
