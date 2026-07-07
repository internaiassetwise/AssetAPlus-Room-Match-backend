# Multi-stage Dockerfile for the Express API.
# Build:  docker build -t room-match-api .
# Run:    docker run --rm -p 4000:4000 -e DATABASE_URL=... room-match-api

# ---------- Stage 1: deps ----------
FROM node:20-alpine AS deps
WORKDIR /app

# Copy only what's needed to install deps (better layer caching)
COPY package.json package-lock.json* ./

# Install with workspaces from the root; everything ends up under root node_modules.
RUN npm ci --include=dev

# ---------- Stage 2: prod deps ----------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---------- Stage 3: runtime ----------
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000

# Bring production node_modules + app source
COPY --from=prod-deps /app/node_modules ./node_modules
COPY src/ ./src/

EXPOSE 4000

# Run the migration step at container start, then the server.
# `--reset` is gated by RESET_DB env to keep it explicit in production.
CMD ["sh", "-c", "if [ \"$RESET_DB\" = \"1\" ]; then node src/db/init.js --reset; else node src/db/init.js; fi && node src/server.js"]