# syntax=docker/dockerfile:1
# Gulf Breeze Air front-desk — one image: build the React platform, run the
# Node server (HTTP API + Twilio webhooks + 2 WebSocket endpoints + static).

# --- Stage 1: build the React platform ---------------------------------------
FROM node:24-slim AS webbuild
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Stage 2: server production dependencies ---------------------------------
# node:24-slim is glibc-based, so better-sqlite3 uses its prebuilt binaries.
FROM node:24-slim AS serverdeps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# --- Runtime ------------------------------------------------------------------
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=serverdeps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
# Read-only import source: the server auto-seeds SQLite from these on first boot.
COPY data/*.jsonl ./data/
COPY --from=webbuild /app/web/dist ./web/dist
EXPOSE 8080
CMD ["node", "server/src/index.js"]
