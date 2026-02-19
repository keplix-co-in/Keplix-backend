# Use Node.js LTS version
FROM node:20-alpine

# Install OpenSSL for Prisma (required for database connections)
RUN apk add --no-cache openssl openssl-dev curl

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

# Expose port 8080 (Cloud Run default)
EXPOSE 8080

# Set environment to production
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:${PORT:-8080}/health || exit 1

# Start the application
CMD ["node", "server.js"]
