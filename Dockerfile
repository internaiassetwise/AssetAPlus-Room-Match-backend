# Multi-stage Dockerfile for the Express API.
# Build:  docker build -t room-match-api .
# Run:    docker run --rm -p 4000:4000 -e DATABASE_URL=... -e PORT=4000 room-match-api
#
# Railway: PORT is injected at runtime. We default it to 4000 if the platform
# doesn't set one, but the platform's value wins.

# ---------- Stage 1: deps ----------
FROM node:20-alpine AS deps
WORKDIR /app

# Copy only what's needed to install deps (better layer caching)
COPY package.json package-lock.json* ./

RUN npm ci --include=dev

# ---------- Stage 2: prod deps ----------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---------- Stage 3: runtime ----------
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
# PORT is injected by Railway at runtime. Don't hardcode it here.
ENV PORT=4000

# Bring production node_modules + app source
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src/ ./src/

# uploads/ is written at runtime (room photos) — create it owned by the
# non-root `node` user the image ships, then drop privileges.
RUN mkdir -p uploads && chown -R node:node /app
USER node

EXPOSE 4000

# Run the migration step at container start, then the server.
# A destructive `--reset` (DROP SCHEMA) requires RESET_DB=confirm-wipe — a
# deliberate value, so a stray "1"/"true" (env typo, leaked var) can't wipe the
# production database on the next boot/restart.
CMD ["sh", "-c", "if [ \"$RESET_DB\" = \"confirm-wipe\" ]; then node src/db/init.js --reset; else node src/db/init.js; fi && node src/server.js"]