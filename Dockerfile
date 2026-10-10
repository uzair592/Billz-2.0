# syntax=docker/dockerfile:1

# ---- Build / dependency stage ----
FROM node:22-alpine AS deps
WORKDIR /app

# Install production dependencies only. The lockfile is the source of
# truth, so the runtime image is reproducible and does not carry dev
# tooling such as Playwright browsers.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Runtime stage ----
FROM node:22-alpine AS runtime

# Run as a dedicated non-root user. The application never writes to the
# filesystem for business data — orders, users, subscriptions, refunds,
# reports, and configuration records all live in PostgreSQL.
ENV NODE_ENV=production \
    NODE_OPTIONS="--disable-warning=ExperimentalWarning"

WORKDIR /app

# Copy only production dependencies from the deps stage.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# Application source: the Fastify API and the POS client it serves.
COPY src ./src
COPY platform-admin ./platform-admin
COPY Fast_Food_POS_Custom_Bill_Header_XXXL.html ./

# The migration runner and bootstrap CLI are release-time tools, not
# part of the runtime request path, but they ship in the image so a
# platform can run them as a release command against the same build.
COPY database ./database

# Non-root user. The container listens on a high port and never needs
# privileged capabilities.
RUN addgroup -S -g 1001 pos && \
    adduser -S -u 1001 -G pos pos && \
    chown -R pos:pos /app
USER pos

# Configured port. Override with PORT at deploy time.
EXPOSE 3000

# Container-level health check: liveness only, no database dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# The production command. SIGTERM/SIGINT are handled for graceful shutdown.
CMD ["node", "src/server/main.mjs"]
