# Aigency OS — Voltron Release

**Autonomous AI agent swarm orchestration on iii primitives.** Route generic-model requests (e.g. `llama3`, `claude-3-opus`) through free-tier providers with automatic failover, JSON drift correction, and zero outbound API cost.

[![Test](https://github.com/AReid987/aigency-router-v2/actions/workflows/test.yml/badge.svg)](https://github.com/AReid987/aigency-router-v2/actions/workflows/test.yml)

---

## Table of Contents

- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Workers Reference](#workers-reference)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Available Scripts](#available-scripts)
- [Testing](#testing)
- [Deployment](#deployment)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)

---

## Key Features

- **Zero-cost LLM routing** — Maps generic model requests to free-tier providers (Groq, Cerebras, Together AI, OpenRouter). No paid API keys required.
- **Automatic failover** — Transparently retries across provider chains on 429, 403, 500, or 503 responses. Keys enter cooldown before retry.
- **SSE streaming** — Server-sent event streaming through the provider chain with `[DONE]` sentinel framing.
- **JSON drift correction** — Repairs malformed JSON from open-source LLMs via `jsonrepair` + LLM fallback loop (max 3 retries).
- **Encrypted key vault** — AES-256-GCM with scrypt-derived keys, zero plaintext secrets on disk.
- **Request classification** — Pluggable selector interface (heuristic or local SLM via llama-cpp-python) for SIMPLE/COMPLEX routing.
- **DAG task orchestration** — Complex requests decomposed into DAG of subtasks with peer-reviewed aggregation.
- **Multi-machine cluster** — PM2 + SSH deployment across 3 MacBooks with Tailscale networking.
- **Real-time telemetry** — SQLite-backed event store with SSE broadcast for live dashboards.
- **Zero-cost circuit breaker** — Per-provider free-tier quota enforcement (Groq 1K, Cerebras 500, Together 800 token limits default).
- **Observability-first** — JSON-structured pino logs with 50+ telemetry event classes flowing to SugarDB.
- **3D Dashboard** — React Three.js dashboard with station-glass design system (DESIGN.md).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Orchestration** | iii Engine — Rust binary (WebSocket + HTTP) |
| **Gateway API** | TypeScript 5.7, Node.js 22 |
| **Workers** | TypeScript (10 workers), Python 3.11+ (1 worker) |
| **Provider Clients** | undici, OpenAI-compatible REST |
| **Encryption** | AES-256-GCM, scrypt key derivation (Node.js `crypto`) |
| **Databases** | better-sqlite3 (vault, telemetry, usage tracking) |
| **JSON Repair** | jsonrepair + LLM fallback (3 retry max) |
| **Streaming** | Server-Sent Events (SSE) |
| **Dashboard** | React 18, Three.js, Tailwind CSS, Vite |
| **TUI** | Python 3.11+, Textual, Typer |
| **Logging** | pino (structured JSON) |
| **Testing** | Node `--test` runner, pytest, tsx |
| **Deployment** | Docker Compose, PM2, SSH, Tailscale |
| **Reverse Proxy** | Caddy 2 |
| **CI** | GitHub Actions (pnpm, Node 22) |

---

## Architecture

```
CLI agent / HTTP client
        │
        ▼
  ┌─────────────────┐
  │   Caddy :443     │  Reverse proxy (TLS termination)
  └────────┬────────┘
           │
  ┌────────▼────────┐
  │ Gateway :8080   │  Core HTTP API — routing, failover, streaming
  └────────┬────────┘
           │ iii WebSocket control plane
           ▼
  ┌────────────────────────────────────────────────────────┐
  │                 iii Engine (:49134)                     │
  │  Rust binary — WebSocket hub, HTTP trigger, state,     │
  │  streams, queues, pubsub, cron, observability          │
  └───┬────┬────┬────┬────┬────┬────┬────┬────┬────┬──────┘
      │    │    │    │    │    │    │    │    │    │
      ▼    ▼    ▼    ▼    ▼    ▼    ▼    ▼    ▼    ▼
   ┌────┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌──────┐
   │Brain│ │Gate│ │Trans│ │Vault│ │Seln │ │Eng.│ │SgrDB│ │Prvd │ │Agents│ │Mem   │
   │(Py) │ │way │ │lator│ │     │ │ctor │ │ram │ │    │ │Clnts│ │     │ │      │
   └─────┘ └───┘ └─────┘ └─────┘ └─────┘ └────┘ └────┘ └────┘ └─────┘ └──────┘
```

### Request Lifecycle

1. **Client** sends `POST /v1/chat/completions` with `{ model, messages }`
2. **Gateway** receives request, extracts model + messages, checks rate limits
3. **Brain** (optional) classifies request as SIMPLE or COMPLEX via pluggable selector
4. **Translator** resolves canonical model name to ordered provider array (failover priority)
5. **Vault** retrieves and decrypts the provider's API key
6. **Provider Client** makes the API call to the primary provider
7. **Failover** catches provider errors (429/403/500/503) and retries through the chain
8. **Engram** (optional) heals malformed JSON response, runs quality gates
9. **SugarDB** logs the telemetry event (model, provider, latency, success/failure)
10. **Response** returned as JSON or SSE stream

### Data Flow

```
model: "llama3" ──► TRANSLATOR ──► ["groq/llama3-8b-8192", 
                                     "cerebras/llama3.1-8b",
                                     "together/..."]
                                        │
                                        ▼
                                  VAULT ──► provider key
                                        │
                                        ▼
                                  GROQ API ──► success? ◄── DONE
                                        │ fail (429/503)
                                        ▼
                                  CEREBRAS ──► success? ◄── DONE
                                        │ fail
                                        ▼
                                  TOGETHER ──► ... ◄── DONE
                                        │ all failed
                                        ▼
                                  503 error
```

---

## Workers Reference

| Worker | Language | Protocol | Port | Functions | Purpose |
|--------|----------|----------|------|-----------|---------|
| **Gateway** | TypeScript | iii+HTTP | 8080 | `route_llm`, `stream_llm`, `status` | Core HTTP API — routing, failover, SSE streaming |
| **Brain** | Python | iii WS | dynamic | `classify`, `status` | Request classification (heuristic or SLM) |
| **Translator** | TypeScript | iii WS | dynamic | `resolve_model`, `translate`, `detect`, `status` | Canonical model name → provider array |
| **Vault** | TypeScript | iii WS | dynamic | `store_key`, `retrieve`, `lock`, `status` | AES-256-GCM encrypted API key storage |
| **Engram** | TypeScript | iii WS | dynamic | `heal_json`, `gate`, `orchestrate`, `record`, `recall`, `status` | JSON drift correction, quality gates, DAG orchestration |
| **Selector** | TypeScript | iii WS | dynamic | `classify`, `status` | Pluggable model request classifier (SLM/heuristic) |
| **SugarDB** | TypeScript | iii+HTTP | 8081 | `log_event`, `query_events`, `status` | SQLite telemetry store + SSE broadcast |
| **Provider Clients** | TypeScript | library | — | (imported) | Groq, Cerebras, Together AI REST clients |
| **Agents** | TypeScript | iii WS | dynamic | *agent-specific* | AI agent infrastructure |
| **Engram (memory)** | TypeScript | iii WS | dynamic | (memory operations) | Event recording and recall |

### Function Registration

All TypeScript workers use `registerWorker()` from `iii-sdk`. Functions are registered synchronously at module load time. Handlers receive `{ action, data, callback }`. The function naming convention is `worker::function_name`:

```
gateway::route_llm      vault::store_key         engram::heal_json
gateway::stream_llm     vault::retrieve          engram::gate
gateway::status         vault::lock              engram::orchestrate
                        vault::list_providers    engram::record
translator::resolve      vault::status            engram::recall
translator::translate                              engram::status
translator::detect      sugar-db::log_event
translator::status      sugar-db::query_events    selector::classify
                        sugar-db::status          selector::status
brain::classify
brain::status
```

---

## Prerequisites

- **Node.js** 20+ (22 LTS recommended)
- **pnpm** 10+ (`corepack enable && corepack prepare pnpm@10 --activate`)
- **Python** 3.11+ (for brain worker and TUI)
- **Docker** 24+ with Compose v2 (optional, for containerized stack)
- **Caddy** 2+ (optional, for bare-metal reverse proxy)
- **Rust** (optional, for building iii Engine from source)
- **Tailscale** (optional, for multi-machine cluster)

---

## Getting Started

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/AReid987/aigency-router-v2.git
cd aigency-router-v2

# Install TypeScript dependencies
pnpm install

# Install Python dependencies (brain worker)
cd workers/brain
pip install -r requirements.txt   # or: uv sync / pdm install
cd ../..

# Install Python dependencies (TUI)
cd tui
pdm install
cd ..
```

### 2. Environment Setup

```bash
cp .env.example .env
```

Edit `.env` with at minimum:

```bash
# Required: at least one free-tier provider key
PROVIDER_KEY_GROQ=gsk_your_groq_key
PROVIDER_KEY_CEREBRAS=cerebras_your_key
# or
PROVIDER_KEY_OPENROUTER=sk-or-v1-your-key

# Vault master key for encrypted API key storage
VAULT_MASTER_KEY="your-64-char-hex-or-strong-password"

# Optional: admin token for protected endpoints
GATEWAY_ADMIN_TOKEN=$(openssl rand -hex 32)
```

### 3. Start the Development Stack

```bash
# Option A: Full stack via Docker Compose
docker compose up -d

# Option B: Bare-metal with iii Engine
iii --config iii.config.yaml &> /tmp/iii.log &
pnpm dev:all
```

### 4. Verify It Works

```bash
# Health check
curl http://127.0.0.1:8080/health

# Send a chat completion
curl -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3","messages":[{"role":"user","content":"Say hello in pirate"}]}'

# Expected response
# {"id":"...","model":"groq/llama3-8b-8192","choices":[{"message":{"role":"assistant","content":"Ahoy there, matey! ..."}}],"usage":{...}}

# SSE streaming
curl -N -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3","messages":[{"role":"user","content":"Count to 5"}],"stream":true}'
```

### 5. Run Integration Smoke Test

```bash
bash scripts/verify-s06.sh
```

This starts all workers, sends curl requests, verifies SSE streaming, checks telemetry, and builds the dashboard.

---

## Environment Variables

### Required

| Variable | Description | How to Get |
|----------|-------------|-----------|
| `VAULT_MASTER_KEY` | Master password for AES-256-GCM key vault | Generate via `openssl rand -hex 32` or a strong passphrase |
| `PROVIDER_KEY_GROQ` | Groq API key | [console.groq.com/keys](https://console.groq.com/keys) |
| `PROVIDER_KEY_CEREBRAS` | Cerebras API key | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| `PROVIDER_KEY_TOGETHER` | Together AI API key | [api.together.ai/settings/api-keys](https://api.together.ai/settings/api-keys) |
| `PROVIDER_KEY_OPENROUTER` | OpenRouter API key | [openrouter.ai/keys](https://openrouter.ai/keys) |

At least one provider key is required for LLM routing. Groq is recommended as the default primary.

### Gateway Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `NODE_ENV` | string | `development` | Runtime environment |
| `LOG_LEVEL` | string | `info` | Pino log level: trace, debug, info, warn, error, fatal |
| `GATEWAY_HEALTH_PORT` | integer | `9090` | Port for the standalone health HTTP server |
| `GATEWAY_RATE_LIMITING` | boolean | `false` | Enable token-bucket rate limiting on `/v1/chat/completions` |
| `GATEWAY_RATE_LIMIT_TOKENS` | integer | `100` | Token bucket capacity |
| `GATEWAY_RATE_LIMIT_WINDOW_MS` | integer | `60000` | Token bucket refill window (ms) |
| `GATEWAY_ADMIN_AUTH` | boolean | `false` | Enable authentication on `/v1/admin/*` endpoints |
| `GATEWAY_ADMIN_TOKEN` | string | — | Admin API access token (generate via `openssl rand -hex 32`) |
| `GATEWAY_CORS` | boolean | `false` | Enable CORS middleware |
| `GATEWAY_MAX_REQUEST_BYTES` | integer | — | Reject requests larger than this many bytes |

### Zero-Cost Enforcement

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `GATEWAY_ZERO_COST_ENFORCEMENT` | boolean | `false` | Enable free-tier circuit breaker |
| `GATEWAY_ZERO_COST_GROQ_LIMIT` | integer | `1000` | Groq free-tier quota (tokens) |
| `GATEWAY_ZERO_COST_CEREBRAS_LIMIT` | integer | `500` | Cerebras free-tier quota (tokens) |
| `GATEWAY_ZERO_COST_TOGETHER_LIMIT` | integer | `800` | Together AI free-tier quota (tokens) |
| `GATEWAY_ZERO_COST_DB_PATH` | path | `./data/usage.db` | SQLite usage tracking database |

### Service URLs

| Variable | Default | Description |
|----------|---------|-------------|
| `III_URL` | `ws://127.0.0.1:49134` | iii Engine WebSocket URL (used by all workers) |
| `GATEWAY_VAULT_URL` | `http://127.0.0.1:8082` | Vault worker HTTP endpoint |
| `GATEWAY_SUGAR_DB_URL` | `http://127.0.0.1:8081` | SugarDB telemetry HTTP endpoint |

### Pipeline and Dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_USE_ENGRAM_PIPELINE` | `false` | Route COMPLEX requests through engram DAG orchestration |
| `GATEWAY_COST_REPORTING` | `false` | Enable per-request cost tracking |
| `GATEWAY_DASHBOARD` | `false` | Enable the web dashboard |
| `GATEWAY_DASHBOARD_STREAM` | `false` | Enable live SSE dashboard updates |

### Provider Rate Configuration

| Variable | Description |
|----------|-------------|
| `COST_RATE_GROQ_USD` | Per-token cost rate for Groq (USD) |
| `COST_RATE_OPENAI_USD` | Per-token cost rate for OpenAI (USD) |
| `PROVIDER_TIER_OVERRIDE` | Override tier classification for all providers |

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev:engine` | Start iii Engine with config |
| `pnpm dev:all` | Start engine + all workers (concurrently) |
| `pnpm test` | Run all TypeScript tests across workspace |
| `pnpm build` | Build all TypeScript packages |
| `docker compose up -d` | Start full Docker stack |
| `bash scripts/verify-s06.sh` | Full E2E integration smoke test |
| `bash deploy/cluster-up.sh` | Start multi-machine cluster via PM2+SSH |
| `bash deploy/cluster-down.sh` | Stop multi-machine cluster |
| `bash deploy/cluster-health.sh` | Check cluster health across nodes |
| `pnpm --filter gateway dev` | Start gateway worker only |
| `pnpm --filter vault dev` | Start vault worker only |
| `pnpm --filter sugar-db dev` | Start SugarDB worker only |
| `cd dashboard && pnpm dev` | Start dashboard dev server (Vite) |
| `cd tui && pdm run voltron` | Launch TUI for vault management |
| `pnpm exec tsx tools/load-test.ts` | Run HTTP load test |
| `pnpm exec tsx tools/rotate-key.ts` | Rotate a provider API key |
| `pnpm exec tsx tools/backup.ts` | Backup SQLite databases |

---

## Testing

### Running Tests

```bash
# All TypeScript tests across the monorepo
pnpm test

# Gateway tests (largest test suite — 18 test files)
pnpm --filter gateway test

# Individual gateway test file
pnpm exec tsx --test workers/gateway/src/index.test.ts

# Engine E2E smoke test
pnpm exec tsx --test iii-engine/src/smoke.test.ts

# Brain worker (Python)
pytest workers/brain/src/test_brain.py

# TUI tests
cd tui && pdm run pytest

# Load testing
pnpm exec tsx tools/load-test.ts
```

### Test Structure

```
tests/
├── integration/           # Cross-worker integration tests
│   ├── test-gateway-pipeline.ts
│   ├── test-cross-worker.ts
│   ├── test-vault-integration.ts
│   ├── test-heal-flow.ts
│   ├── test-cost-reporting.ts
│   ├── test-zero-cost-enforcement.ts
│   ├── test-engram-pipeline.ts
│   ├── test-offload-flow.ts
│   ├── test-bonsai-classifier.py
│   └── test-docker-compose-stack.sh
└── unit/                   # Unit tests
    ├── load-test.test.ts
    ├── rotate-key.test.ts
    └── backup.test.ts

workers/gateway/src/        # Gateway unit tests (18 test files)
├── index.test.ts
├── provider-client.test.ts
├── failover.test.ts
├── streaming.test.ts
├── rate-limiter.test.ts
├── middleware.test.ts
├── http-handler.test.ts
├── health.test.ts
├── lifecycle.test.ts
├── logger.test.ts
├── dag-planner.test.ts
├── parallel_scheduler.test.ts
├── distributor.test.ts
├── peer_reviewer.test.ts
└── heal-integration.test.ts
```

### CI Pipeline

GitHub Actions runs on push/PR to `main`:

1. Checkout + pnpm setup (v11)
2. Node 22, dependency install (`--frozen-lockfile`)
3. `pnpm test` across all workspace packages
4. `iii-sdk` stub type verification

---

## Deployment

### Primary Path — Docker Compose

```bash
# Start full stack
docker compose up -d

# Verify
curl -k https://127.0.0.1:8443/health
# → {"status":"ok","uptimeMs":...,"version":"0.1.0"}

# Check readiness (dependency probes)
curl -k https://127.0.0.1:8443/ready
# → {"status":"ready","checks":{"vault":{"ok":true,"latencyMs":5},"sugarDb":{"ok":true,"latencyMs":3}}}

# View logs
docker compose logs -f
```

The Docker Compose stack starts: SugarDB → Vault → Translator → Gateway → Caddy → Backup sidecar. Seven services total. Caddy handles TLS termination on port 8443.

### Multi-Machine Cluster (Tailscale + PM2)

The system deploys across 3 MacBooks via SSH and PM2:

**Control plane (Mac 1):** iii Engine + SugarDB + Gateway + Vault + Translator  
**Worker A (Mac 2):** Gateway worker (failover) + Selector  
**Worker B (Mac 3):** Gateway worker (failover) + Selector

```bash
# Prerequisites
# 1. SSH keys to all 3 machines (ssh-copy-id)
# 2. pm2 installed on all 3 (npm i -g pm2)
# 3. Repo cloned to identical path on all machines
# 4. cluster-config.sh edited with Tailscale IPs

# Deploy
export GATEWAY_ADMIN_TOKEN="$(openssl rand -hex 32)"
export VAULT_MASTER_KEY="your-vault-key"
./deploy/cluster-up.sh

# Verify
./deploy/cluster-health.sh

# Stop all
./deploy/cluster-down.sh
```

The deployment script:
1. Verifies SSH connectivity and PM2 availability on all nodes
2. Starts SugarDB (Docker) on the control plane
3. Starts iii Engine on the control plane
4. Deploys all workers in parallel across nodes via PM2
5. Reports deployment status

### Bare-Metal

```bash
# Start engine
iii --config iii.config.yaml &

# Start workers (each in its own terminal or background)
node --import tsx workers/gateway/src/index.ts &
node --import tsx workers/translator/src/index.ts &
node --import tsx workers/vault/src/index.ts &
node --import tsx workers/sugar-db/src/index.ts &

# Verify chain
curl -X POST http://127.0.0.1:3111/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3","messages":[{"role":"user","content":"hello"}]}'
```

### Vercel (Dashboard Only)

The dashboard (`dashboard/`) deploys independently to Vercel:

```bash
cd dashboard
vercel --prod
```

Build config: `cd dashboard && pnpm build` → output in `dashboard/dist/`.

---

## Operations

### Secret Management

**Admin token:**
```bash
openssl rand -hex 32   # 64-character hex string
```

**Provider API key rotation:**
```bash
# Add a new key (old key marked deprecated)
pnpm exec tsx tools/rotate-key.ts groq --new-key gsk-new...

# Notify gateway to hot-reload
kill -SIGUSR1 $(pgrep -f "workers/gateway")

# 24h later: prune deprecated keys
pnpm exec tsx tools/rotate-key.ts groq --prune
```

Keys are stored in the Vault encrypted at rest. The key rotation tool handles versioning with `deprecatedAt` timestamps and hot-reload signaling via `SIGUSR1`.

### Monitoring

**Telemetry event dashboard** (enable via `GATEWAY_DASHBOARD=true`):

The SugarDB worker exposes an SSE endpoint on port 3115. Key telemetry events:

| Event Class | Trigger | Action |
|-------------|---------|--------|
| `PROVIDER_FAILOVER` | Provider returned error, failover activated | Alert if >3/min per provider |
| `QUOTA_EXHAUSTED` | Free-tier limit reached | Rotate or top up key |
| `DRIFT_HEALED` | Malformed JSON repaired | Track drift rate per provider |
| `AUTH_REJECTED` | Invalid/expired admin token | Investigate if >5/min |
| `RATE_LIMIT_EXCEEDED` | Client rate limited | Investigate if >100/min |
| `HEALTH_CHECK_FAIL` | Dependency unhealthy | Page on-call if >30s |

**Logging:**
```bash
# Docker
docker compose logs gateway

# PM2
pm2 logs gateway

# Raw pino logs (newline-delimited JSON)
tail -f /var/log/gateway.log | jq '.'
```

### Backup

A Docker sidecar runs daily SQLite backups:
```bash
# Manual backup
pnpm exec tsx tools/backup.ts

# Backups stored in Docker volume: backup-data
docker run --rm -v backup-data:/backups alpine ls /backups/
```

### Cluster Health

```bash
./deploy/cluster-health.sh
# Output:
# NODE                 SSH        PM2              HEALTH     DETAILS
# Mac 1 (Control Plane) ✓         gateway running  ok         uptime 2h
# Mac 2 (Worker A)      ✓         gateway-a run... ok         uptime 2h
# Mac 3 (Worker B)      ✓         gateway-b run... ok         uptime 2h
```

---

## Troubleshooting

### Provider Errors

**Symptom:** `{"error":"all_providers_exhausted","attempts":3}`

**Check:**
1. Verify provider keys are set and not expired
2. Check `docker compose logs gateway` for failover details
3. Run `curl http://localhost:9090/health` to verify gateway is up
4. Check translator model map in `workers/translator/src/canonical-maps.ts`
5. If using zero-cost enforcement, check if quota is exhausted:
   ```bash
   curl -H "X-Admin-Token: $TOKEN" http://localhost:8080/v1/admin/quota
   ```

### Vault Issues

**Symptom:** `{"error":"vault_locked","message":"Vault is locked"}`

**Fix:**
1. Set `VAULT_MASTER_KEY` environment variable
2. Or unlock interactively via the TUI: `cd tui && pdm run voltron`

### Engine Connection Failures

**Symptom:** Workers fail to register with iii Engine

**Check:**
1. Is `iii` running? `pgrep -x iii || echo "not running"`
2. Verify `III_URL` in `.env` matches the engine WebSocket port
3. Check engine logs: `cat /tmp/iii.log`
4. Verify port availability: `lsof -i :49134`

### Streaming Issues

**Symptom:** SSE stream cuts off or no chunks received

**Fix:**
1. Ensure the client sends `"stream":true` in the request body
2. Check for gateway error logs with event class `STREAM_ERROR`
3. Verify the provider supports streaming (some free-tier endpoints don't)

### Database Corruption

**Symptom:** `SQLITE_CORRUPT` errors in vault or SugarDB

**Fix:**
```bash
# Restore from latest backup
docker compose stop vault sugar-db
cp /backups/vault-$(date +%Y%m%d).db data/vault.db
cp /backups/usage-$(date +%Y%m%d).db data/usage.db
docker compose start vault sugar-db
```

### Graceful Shutdown

All workers handle SIGTERM and SIGINT for clean drain:

```bash
# 30-second drain timeout, then force exit
kill -TERM $(pgrep -f "workers/gateway")
```

---

## Project Structure

```
├── iii-engine/                # Orchestration hub (WebSocket + HTTP)
│   ├── src/
│   │   ├── engine.ts          # Engine class — worker registration, HTTP, channels
│   │   ├── smoke.test.ts      # E2E smoke test
│   │   ├── http-handler.ts    # HTTP trigger handler
│   │   └── protocol.md        # Wire protocol docs
│   └── Dockerfile
│
├── iii-sdk/                   # TypeScript SDK for iii Engine
│   └── src/
│       ├── index.ts           # SDK types + stubs (production SDK in node_modules)
│       ├── state.ts
│       └── stream.ts
│
├── workers/
│   ├── gateway/               # Core HTTP API — routing, failover, streaming
│   │   └── src/
│   │       ├── index.ts       # Gateway worker entry + routeLlm()
│   │       ├── middleware.ts  # Rate limiting, admin auth, CORS, size limit
│   │       ├── rate-limiter.ts # Token-bucket rate limiter
│   │       ├── lifecycle.ts   # Graceful shutdown (SIGTERM/SIGINT drain)
│   │       └── *.test.ts      # 18 test files
│   │
│   ├── vault/                 # Encrypted API key management
│   │   └── src/
│   │       ├── index.ts       # Vault worker entry
│   │       ├── vault.ts       # VaultManager — crypto orchestration
│   │       ├── crypto.ts      # AES-256-GCM encrypt/decrypt (scrypt)
│   │       ├── db.ts          # SugarVaultDB (better-sqlite3)
│   │       └── selector.ts    # Key selection logic
│   │
│   ├── translator/            # Model name → provider route resolution
│   │   └── src/
│   │       ├── index.ts       # Translator worker + resolveModel()
│   │       └── canonical-maps.ts # 12 canonical model mappings
│   │
│   ├── engram/                # JSON drift correction, quality gates, DAG
│   │   └── src/
│   │       ├── index.ts       # Engram worker entry
│   │       ├── heal-json.ts   # healJson() — jsonrepair + LLM fallback
│   │       ├── orchestrate.ts # DAG orchestrator (task decomposition)
│   │       ├── quality_gate.ts # Quality gate evaluator
│   │       └── hallucination_detector.ts
│   │
│   ├── sugar-db/              # SQLite telemetry + SSE broadcast
│   │   └── src/
│   │       ├── index.ts       # SugarDB worker entry
│   │       ├── db.ts          # SugarDB class (SQLite via better-sqlite3)
│   │       └── sse.ts         # SSE server for live dashboards
│   │
│   ├── selector/              # Pluggable request classifier
│   │   └── src/
│   │       └── index.ts       # Selector worker (SLM or heuristic)
│   │
│   ├── brain/                 # Python worker for AI classification
│   │   └── src/
│   │       └── main.py        # Brain worker (heuristic or llama-cpp SLM)
│   │
│   ├── provider-clients/      # Provider API clients
│   │   └── src/
│   │       ├── base.ts        # Base HTTP client
│   │       ├── groq.ts        # Groq API client
│   │       ├── cerebras.ts    # Cerebras API client
│   │       ├── together.ts    # Together AI API client
│   │       ├── openai-compatible.ts # Generic OpenAI-compatible client
│   │       └── types.ts       # Shared response types
│   │
│   ├── shared/                # Shared TypeScript modules
│   │   └── telemetry.ts       # 50+ event class telemetry helper
│   │
│   └── agents/                # AI agent infrastructure
│
├── dashboard/                 # React Three.js observability dashboard
│   └── src/
│       ├── components/        # UI components
│       ├── hooks/             # React hooks
│       └── store/             # Zustand state store
│
├── tui/                       # Python Textual CLI/TUI
│   └── tui/src/
│       ├── cli.py             # Typer CLI (keys add/list/remove, tui)
│       └── db.py              # SugarVaultDB for TUI
│
├── deploy/
│   ├── cluster-up.sh          # Start multi-machine cluster via PM2+SSH
│   ├── cluster-down.sh        # Stop multi-machine cluster
│   ├── cluster-health.sh      # Check cluster health
│   ├── cluster-config.sh      # Cluster IP and service config
│   ├── ecosystem.config.cjs   # PM2 process definitions (3 nodes)
│   └── caddy/
│       └── Caddyfile          # Reverse proxy config
│
├── tools/
│   ├── load-test.ts           # HTTP load test
│   ├── rotate-key.ts          # Provider API key rotation
│   ├── backup.ts              # SQLite backup utility
│   └── sigusr1.js             # Hot-reload helper
│
├── tests/
│   ├── integration/           # Cross-worker integration tests (18 files)
│   └── unit/                  # Unit tests
│
├── scripts/
│   ├── verify-s01.sh          # Stage 1 verification
│   ├── verify-s05.sh          # Stage 5 verification
│   ├── verify-s06.sh          # Full E2E verification (recommended)
│   ├── parallel-start.sh      # Parallel worker startup
│   └── fetch-bonsai.sh        # Fetch local SLM model
│
├── iii.config.yaml            # iii Engine worker configuration
├── docker-compose.yml         # Full Docker stack (7 services)
├── Dockerfile                  # Multi-stage gateway build
├── pnpm-workspace.yaml         # pnpm workspace definition
├── vercel.json                 # Vercel dashboard deployment config
├── DESIGN.md                   # Station Glass design system
├── AGENTS.md                   # Agent instructions + GitNexus reference
├── CLAUDE.md                   # Agent-specific project instructions
└── docs/
    └── OPERATIONS.md           # Full operations manual
```

---

## Canonical Model Map

The translator maps generic model names to ordered provider arrays. Order defines failover priority (index 0 = primary).

| Canonical Name | Provider Chain |
|---------------|----------------|
| `llama3` | groq → cerebras → together |
| `llama3-70b` | groq → together |
| `mistral-large-latest` | openrouter → groq |
| `mistral-small-latest` | openrouter → groq |
| `deepseek-v4-flash` | openrouter → groq |
| `deepseek-v4-pro` | openrouter → groq |
| `gpt-oss` | cerebras → groq → together |
| `openrouter/free` | openrouter (single) |

Add new mappings in `workers/translator/src/canonical-maps.ts`.

---

## Design System

The dashboard uses the "Station Glass" design language (designated in `DESIGN.md`):

- **Colors:** OKLCH exclusively — Void deep backgrounds (0.10 0.015 250), Warm amber accents (0.75 0.150 65)
- **Typography:** Geist Pixel (system), JetBrains Mono (body), Space Grotesk (display). No serif.
- **Borders:** All zero border radius — sharp corners. 1px structural lines via box-shadow.
- **Elevation:** No drop shadows. Content sits "on the glass."
- **Motion:** Exponential easing only. Data state = 2s, System state = 0.6s, Signal state = 0.2s.

---

## License

Private — internal project. No license specified.
