<!-- icm:start -->
## Persistent memory (ICM) — MANDATORY

This project uses [ICM](https://github.com/rtk-ai/icm) for persistent memory across sessions.
You MUST use it actively. Not optional.

### Recall (before starting work
```bash
icm recall "query"                        # search memories
icm recall "query" -t "topic-name"        # filter by topic
icm recall-context "query" --limit 5      # formatted for prompt injection
```

### Store — MANDATORY triggers
You MUST call `icm store` when ANY of the following happens:
1. **Error resolved** → `icm store -t errors-resolved -c "description" -i high -k "keyword1,keyword2"`
2. **Architecture/design decision** → `icm store -t decisions-{project} -c "description" -i high`
3. **User preference discovered** → `icm store -t preferences -c "description" -i critical`
4. **Significant task completed** → `icm store -t context-{project} -c "summary of work done" -i high`
5. **Conversation exceeds ~20 tool calls without a store** → store a progress summary

Do this BEFORE responding to the user. Not after. Not later. Immediately.

Do NOT store: trivial details, info already in CLAUDE.md, ephemeral state (build logs, git status).

### Other commands
```bash
icm update <id> -c "updated content"     # edit memory in-place
icm health                                # topic hygiene audit
icm topics                                # list all topics
```
<!-- icm:end -->

---

## Aigency OS — Agent Instructions

### Project Overview

Aigency OS (Voltron Release) routes generic-model requests (e.g., `llama3`, `claude-3-opus`) through free-tier providers with automatic failover and JSON drift correction. All workers communicate via [iii.dev](https://iii.dev) Engine — a Rust binary that runs locally and exposes WebSocket + HTTP APIs.

### Architecture

```
CLI agent
  → iii HTTP Trigger :3111
  → brain worker (Python)     — classifies SIMPLE/COMPLEX
  → gateway worker (TypeScript) — routes + failover + streams SSE
  → translator (TypeScript)    — canonical model → provider array
  → vault worker (TypeScript)  — AES-256-GCM encrypted key storage
  → engram worker (TypeScript) — JSON drift correction
  → SugarDB (TypeScript)      — telemetry + SSE dashboard
```

### Key Workers

| Worker | Language | Port | Key Files |
|--------|----------|------|-----------|
| brain | Python | WS 49134 | `workers/brain/src/main.py` |
| gateway | TypeScript | :3111 | `workers/gateway/src/index.ts` |
| vault | TypeScript | WS 49134 | `workers/vault/src/vault.ts` |
| engram | TypeScript | WS 49134 | `workers/engram/src/pipeline.ts` |
| translator | TypeScript | WS 49134 | `workers/translator/src/index.ts` |
| sugar-db | TypeScript | WS 49134 | `workers/sugar-db/src/db.ts` |

### Critical Patterns

**iii worker function registration** — All TypeScript workers use `registerWorker()` from `iii-sdk`. Functions are registered synchronously at module load time. Handlers receive `{ action, data, callback }`.

**Structured logs** — Workers emit machine-readable JSON logs (not natural language). Keys: `event`, `timestamp`, `model`, `provider`, `failoverTriggered`, etc.

**Worker function pattern per worker:**
- `gateway::route_llm` — primary routing action
- `gateway::stream_llm` — SSE streaming path
- `gateway::status` — health check
- `vault::store_key`, `vault::get_key`, `vault::list_providers`, `vault::status`
- `engram::heal_json`, `engram::status`
- `translator::resolve_model`, `translator::status`
- `brain::classify`, `brain::status`

**Binary format for encrypted vault:** `[salt 16B][iv 12B][authTag 16B][ciphertext]`. Both Python (cryptography library) and TypeScript (Node crypto) produce identical binary layouts.

**SSE format:** `data: {...JSON...}\n\n` chunks + `data: [DONE]` sentinel. Provider chunks are buffered and re-emitted through the channel.

**Failover triggers:** 429 (rate limit), 403 (revoked key), 500/503 (server error). Keys enter cooldown before retry.

### Dev Commands

```bash
# Start all workers (from project root)
iii start          # starts Engine + all workers via iii.config.yaml
iii console        # open iii Console on :3113

# TypeScript tests
pnpm -r --filter '@aigency/*' test

# Python tests
pytest workers/brain/src/test_brain.py

# Integration
bash scripts/verify-s06.sh    # full E2E — starts workers + curl + SSE + telemetry + dashboard build

# Dashboard
cd dashboard && pnpm run dev
```



### Run the Chain

```bash
# 1. Start the iii engine (port 49134 = WS, 3111 = iii-http)
iii --config iii.config.yaml >/dev/null 2>&1 &

# 2. Start workers (each in its own terminal or & in background)
node --import tsx workers/gateway/src/index.ts >/dev/null 2>&1 &
node --import tsx workers/translator/src/index.ts >/dev/null 2>&1 &
node --import tsx workers/vault/src/index.ts >/dev/null 2>&1 &

# 3. Issue HTTP request through engine
curl -X POST http://127.0.0.1:3111/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"echo","messages":[{"role":"user","content":"hello"}]}'

# Or run the full smoke test (starts engine + workers + verifies chain)
bash .gsd/scripts/smoke-s03.sh
```

### Requirements

All active requirements are tracked in `.gsd/REQUIREMENTS.md`. Priority order for M001 was: R006 (workers) → R003 (vault) → R001/R002 (routing) → R005 (streaming) → R007/R008 (failover/multiplexing) → R004 (drift correction) → R009/R010 (observability). M002 adds SLM routing; M003 adds DAG decomposition.

### Key Constraints

- **Zero outbound API cost** — Free-tier provider quotas only. No paid API calls.
- **Pluggable selector interface** — HeuristicSelector now, SLMSelector in M002. Interface is `Selector` with `classify()`.
- **Pluggable repair pipeline** — `jsonrepair` local pass first, LLM repair (max 3 retries) as fallback. R013.
