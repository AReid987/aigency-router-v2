# =============================================================================
# Multi-stage Dockerfile for @aigency/gateway
#
# Stage 1: builder — install deps and compile
# Stage 2: runtime — minimal image with compiled artifact
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — Builder
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

RUN corepack enable

WORKDIR /app

# ----- Copy dependency manifests -------------------------------------------
# Root manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# All workspace package.json files (needed by pnpm to resolve workspace: deps)
COPY workers/gateway/package.json      ./workers/gateway/package.json
COPY workers/shared/package.json       ./workers/shared/package.json
COPY workers/provider-clients/package.json ./workers/provider-clients/package.json
COPY workers/engram/package.json       ./workers/engram/package.json
COPY workers/selector/package.json     ./workers/selector/package.json
COPY workers/translator/package.json   ./workers/translator/package.json
COPY workers/vault/package.json        ./workers/vault/package.json
COPY workers/sugar-db/package.json     ./workers/sugar-db/package.json
COPY dashboard/package.json            ./dashboard/package.json
COPY iii-sdk/package.json              ./iii-sdk/package.json
COPY iii-engine/package.json          ./iii-engine/package.json

# ----- Install dependencies (frozen lockfile) ------------------------------
RUN pnpm install --frozen-lockfile

# ----- Copy all source code ------------------------------------------------
COPY tsconfig.json ./
COPY workers ./workers
COPY iii-sdk ./iii-sdk
COPY iii-engine ./iii-engine
COPY dashboard ./dashboard

# ----- Build the gateway package -------------------------------------------
# Build output goes to workers/gateway/dist (per tsconfig outDir)
RUN pnpm --filter @aigency/gateway exec tsc --project tsconfig.json --allowImportingTsExtensions --outDir dist --rootDir . --declaration --declarationMap --sourceMap --skipLibCheck

# ---------------------------------------------------------------------------
# Stage 2 — Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# Install dumb-init for proper signal handling (SIGTERM graceful shutdown)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy compiled output and production dependencies from builder
COPY --from=builder /app/workers/gateway/dist    ./workers/gateway/dist
COPY --from=builder /app/workers/gateway/package.json ./workers/gateway/package.json
COPY --from=builder /app/node_modules            ./node_modules
COPY --from=builder /app/pnpm-lock.yaml          ./
COPY --from=builder /app/package.json            ./

# Shared workspace types referenced at runtime by the compiled output
COPY --from=builder /app/workers/shared          ./workers/shared
COPY --from=builder /app/iii-sdk                 ./iii-sdk

# Run as non-root user
USER node

ENV NODE_ENV=production

EXPOSE 8080

# Health check against the /health endpoint (S01 establishes this contract)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8080/health"] || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "workers/gateway/dist/index.js"]
