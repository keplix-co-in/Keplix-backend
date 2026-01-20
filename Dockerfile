# Use Node.js LTS version
FROM node:20-alpine

# Install OpenSSL for Prisma (required for database connections)
RUN apk add --no-cache openssl openssl-dev

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies first (needed for Prisma generation)
# Using npm install since package-lock.json may not exist
RUN npm install --legacy-peer-deps

# Copy prisma schema
COPY prisma ./prisma/

# Generate Prisma Client with the correct version from package.json
RUN npx prisma@5.22.0 generate

# Copy application code
COPY . .

# Remove dev dependencies to reduce image size
RUN npm prune --omit=dev --legacy-peer-deps

# Expose port (update if your app uses a different port)
EXPOSE 8000

# Set environment to production
ENV NODE_ENV=production

# Start the application
CMD ["node", "server.js"]
