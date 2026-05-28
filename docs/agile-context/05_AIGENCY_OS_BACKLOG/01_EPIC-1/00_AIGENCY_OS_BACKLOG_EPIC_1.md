# EPIC 1: The Gateway Spine & Security Vault

## Overview Description
This epic represents the foundational "Egress" layer of the Voltron release. It replaces the legacy hardcoded `.env` file system with a highly secure, AES-256 encrypted local SQLite database (SugarVault). It also introduces the core routing engine (OmniGateway) and the abstraction middleware (ModelTranslator) that will allow agents to request generic models while the system routes to specific, multiplexed free-tier keys.

## Overall Goal
Prove that a canonical model request (e.g., "llama3") can be received, translated into a prioritized array of specific providers, and successfully routed using dynamically decrypted credentials pooled across multiple virtual colleagues, all without dropping a single request or leaking a plaintext key.

***

## Story 1.1: Workspace Cleanup & Legacy Deprecation

**Overview Description:** Before we build the new architecture, we must purge the technical debt. This story involves safely removing all vector database dependencies (`ruvector-postgres`) and stripping out any legacy `.env` credential loaders that pose a security risk.

**Complexity Score:** 2 (Simple)

**Dependencies:** None

**Developer Guidance:** Do not just delete the folder. Ensure the `package.json`, `tsconfig.json`, and `pnpm-workspace.yaml` are completely stripped of any `ruvector` references. Run a full workspace compile after deletion.

### Checkbox Tasklist:
* [ ] Delete `ruvector-postgres` directory completely.
* [ ] Remove related DB drivers (pg, pg-pool) from root `package.json`.
* [ ] Search codebase for `process.env.OPENAI_API_KEY` and remove native loaders.
* [ ] Run `pnpm install` to ensure lockfile is clean and builds pass.

### Acceptance Criteria:
* Workspace compiles without errors.
* No references to Postgres or Ruvector exist in the codebase.
* `.env` file no longer contains active API keys for providers.

### Resource URLs:
* pnpm Workspaces: [https://pnpm.io/workspaces](https://pnpm.io/workspaces)

***

## Story 1.2: SugarVault Initialization

**Overview Description:** Establish the foundational SQLite database for secure credential storage using AES-256-GCM encryption.

**Complexity Score:** 8 (Complex - Security Critical)

**Dependencies:** Story 1.1

**Developer Guidance:** Use Node.js native `crypto` module. The master key should be passed into the server instance via a secure memory buffer on startup, never written to disk. The `better-sqlite3` package should be used for synchronous, fast local reads.

### Checkbox Tasklist:
* [ ] Install `better-sqlite3` and configure connection to `./.sugar/vault.db`.
* [ ] Write SQL migration to create `credentials` table (id, provider, encrypted_key, virtual_colleague_id, active).
* [ ] Create AES-256-GCM encrypt/decrypt utility functions.
* [ ] Build TS class `VaultManager` to expose safe retrieval methods to the OmniGateway.

### Acceptance Criteria:
* SQLite file is generated on application boot if missing.
* Mock API keys inserted into the DB are stored as BLOB ciphertexts.
* `VaultManager.getKey('groq')` successfully returns plaintext only in memory.

### Resource URLs:
* better-sqlite3: [https://github.com/WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
* Node Crypto: [https://nodejs.org/api/crypto.html](https://nodejs.org/api/crypto.html)

***

## Story 1.3: Port Providers to Vault Ecosystem

**Overview Description:** Extract the existing API connection logic from the `freellmapi` source and adapt it to dynamically pull credentials from the new SugarVault.

**Complexity Score:** 5 (Medium)

**Dependencies:** Story 1.2

**Developer Guidance:** Focus strictly on Groq, Cerebras, and Together AI for the MVP. They must implement a unified `ChatCompletionProvider` interface.

### Checkbox Tasklist:
* [ ] Create `src/providers/` directory.
* [ ] Port `groq.ts`, `cerebras.ts`, and `together.ts`.
* [ ] Refactor their constructors to accept a dynamic API key fetched from `VaultManager` just-in-time.

### Acceptance Criteria:
* Provider classes successfully execute a `fetch()` call to their respective upstream APIs using decrypted Vault keys.

### Resource URLs:
* Groq API: [https://console.groq.com/docs/api-reference](https://console.groq.com/docs/api-reference)
* Cerebras API: [https://inference-docs.cerebras.ai/](https://inference-docs.cerebras.ai/)
* Together AI API: [https://docs.together.ai/docs/inference-rest](https://docs.together.ai/docs/inference-rest)

***

## Story 1.4: ModelTranslator Middleware

**Overview Description:** Implement canonical grouping logic to map generic agent requests into provider-specific arrays based on Quality of Service (QoS).

**Complexity Score:** 5 (Medium)

**Dependencies:** Story 1.3

**Developer Guidance:** This is a pure data-transformation layer. If the input is `llama3`, the output should be `['groq/llama3-8b-8192', 'cerebras/llama3.1-8b']`. Store these mappings in a configuration JSON that can be hot-reloaded.

### Checkbox Tasklist:
* [ ] Define `canonical_maps.json`.
* [ ] Create `ModelTranslator.ts` class with a `resolve(canonicalName: string)` method.
* [ ] Write Jest tests validating fallback mapping order.

### Acceptance Criteria:
* Given a canonical string, the middleware returns a valid array of specific provider endpoints.
* Throws a specific `UnknownModelError` if the requested canonical string is not in the map.

***

## Story 1.5: OmniGateway Multiplexer

**Overview Description:** Wire the QuotaTracker into the gateway and implement logic to rotate and multiplex keys across "virtual colleagues" during routing.

**Complexity Score:** 13 (Highly Complex)

**Dependencies:** Story 1.2, 1.4

**Developer Guidance:** This is the core engine. It must handle 429 Rate Limits by catching the error, logging it to SugarDB, marking that specific Vault Key as cooling down, and instantly retrying the request with the next key in the pool.

### Checkbox Tasklist:
* [ ] Integrate `QuotaTracker.ts` to log token usage post-request.
* [ ] Implement connection pool rotation logic (round-robin across active Virtual Colleagues).
* [ ] Build the error interception loop to catch 429s and trigger instant failovers.

### Acceptance Criteria:
* A simulated 429 error from Groq Key 1 seamlessly fails over to Groq Key 2 and returns a successful response to the user without dropping the HTTP connection.

***

## Story 1.6: TS Ingress Endpoint

**Overview Description:** Expose the Node.js OmniGateway via a local HTTP server so the Python layer can communicate with it.

**Complexity Score:** 3 (Simple)

**Dependencies:** Story 1.5

**Developer Guidance:** Use standard Node HTTP or Fastify. This must exactly mirror the OpenAI `/v1/chat/completions` schema to ensure upstream compatibility.

### Checkbox Tasklist:
* [ ] Setup Fastify server on port 3000.
* [ ] Create POST route parsing standard OpenAI JSON body.
* [ ] Pipe request to OmniGateway and return the stream.

### Acceptance Criteria:
* A local cURL to `http://localhost:3000/v1/chat/completions` returns a valid streamed response.

### Resource URLs:
* Fastify Docs: [https://fastify.dev/docs/latest/](https://fastify.dev/docs/latest/)