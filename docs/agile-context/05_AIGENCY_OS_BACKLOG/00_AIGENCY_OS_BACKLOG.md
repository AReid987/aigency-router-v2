# **Aigency OS (Voltron Release): Master Sprint Backlog**

**Date:** May 7, 2026  
**Document Status:** Active Execution

## **Master Index**

* **Epic 1: The Gateway Spine & Security Vault** (6 Stories)  
* **Epic 2: The Memory & Brain** (4 Stories)  
* **Epic 3: Semantic Middleware (Engram)** (4 Stories)  
* **Epic 4: Control & Observability (Dual Interface)** (5 Stories)

*Note: This document utilizes strict page-break separation. Each Epic overview and each Story specification begins on a new page to allow for easy printing, PDF export, and individual developer assignment.*

# **EPIC 1: The Gateway Spine & Security Vault**

## **Overview Description**

This epic represents the foundational "Egress" layer of the Voltron release. It replaces the legacy hardcoded .env file system with a highly secure, AES-256 encrypted local SQLite database (SugarVault). It also introduces the core routing engine (OmniGateway) and the abstraction middleware (ModelTranslator) that will allow agents to request generic models while the system routes to specific, multiplexed free-tier keys.

## **Overall Goal**

Prove that a canonical model request (e.g., "llama3") can be received, translated into a prioritized array of specific providers, and successfully routed using dynamically decrypted credentials pooled across multiple virtual colleagues, all without dropping a single request or leaking a plaintext key.

## **Story 1.1: Workspace Cleanup & Legacy Deprecation**

**Overview Description:** Before we build the new architecture, we must purge the technical debt. This story involves safely removing all vector database dependencies (ruvector-postgres) and stripping out any legacy .env credential loaders that pose a security risk.  
**Complexity Score:** 2 (Simple)  
**Dependencies:** None  
**Developer Guidance:** Do not just delete the folder. Ensure the package.json, tsconfig.json, and pnpm-workspace.yaml are completely stripped of any ruvector references. Run a full workspace compile after deletion.

### **Checkbox Tasklist:**

* \[ \] Delete ruvector-postgres directory completely.  
* \[ \] Remove related DB drivers (pg, pg-pool) from root package.json.  
* \[ \] Search codebase for process.env.OPENAI\_API\_KEY and remove native loaders.  
* \[ \] Run pnpm install to ensure lockfile is clean and builds pass.

### **Acceptance Criteria:**

* Workspace compiles without errors.  
* No references to Postgres or Ruvector exist in the codebase.  
* .env file no longer contains active API keys for providers.

### **Resource URLs:**

* pnpm Workspaces: https://pnpm.io/workspaces

## **Story 1.2: SugarVault Initialization**

**Overview Description:** Establish the foundational SQLite database for secure credential storage using AES-256-GCM encryption.  
**Complexity Score:** 8 (Complex \- Security Critical)  
**Dependencies:** Story 1.1  
**Developer Guidance:** Use Node.js native crypto module. The master key should be passed into the server instance via a secure memory buffer on startup, never written to disk. The better-sqlite3 package should be used for synchronous, fast local reads.

### **Checkbox Tasklist:**

* \[ \] Install better-sqlite3 and configure connection to ./.sugar/vault.db.  
* \[ \] Write SQL migration to create credentials table (id, provider, encrypted\_key, virtual\_colleague\_id, active).  
* \[ \] Create AES-256-GCM encrypt/decrypt utility functions.  
* \[ \] Build TS class VaultManager to expose safe retrieval methods to the OmniGateway.

### **Acceptance Criteria:**

* SQLite file is generated on application boot if missing.  
* Mock API keys inserted into the DB are stored as BLOB ciphertexts.  
* VaultManager.getKey('groq') successfully returns plaintext only in memory.

### **Resource URLs:**

* better-sqlite3: https://github.com/WiseLibs/better-sqlite3  
* Node Crypto: https://nodejs.org/api/crypto.html

## **Story 1.3: Port Providers to Vault Ecosystem**

**Overview Description:** Extract the existing API connection logic from the freellmapi source and adapt it to dynamically pull credentials from the new SugarVault.  
**Complexity Score:** 5 (Medium)  
**Dependencies:** Story 1.2  
**Developer Guidance:** Focus strictly on Groq, Cerebras, and Together AI for the MVP. They must implement a unified ChatCompletionProvider interface.

### **Checkbox Tasklist:**

* \[ \] Create src/providers/ directory.  
* \[ \] Port groq.ts, cerebras.ts, and together.ts.  
* \[ \] Refactor their constructors to accept a dynamic API key fetched from VaultManager just-in-time.

### **Acceptance Criteria:**

* Provider classes successfully execute a fetch() call to their respective upstream APIs using decrypted Vault keys.

### **Resource URLs:**

* Groq API: https://console.groq.com/docs/api-reference

## **Story 1.4: ModelTranslator Middleware**

**Overview Description:** Implement canonical grouping logic to map generic agent requests into provider-specific arrays based on Quality of Service (QoS).  
**Complexity Score:** 5 (Medium)  
**Dependencies:** Story 1.3  
**Developer Guidance:** This is a pure data-transformation layer. If the input is llama3, the output should be \['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'\]. Store these mappings in a configuration JSON that can be hot-reloaded.

### **Checkbox Tasklist:**

* \[ \] Define canonical\_maps.json.  
* \[ \] Create ModelTranslator.ts class with a resolve(canonicalName: string) method.  
* \[ \] Write Jest tests validating fallback mapping order.

### **Acceptance Criteria:**

* Given a canonical string, the middleware returns a valid array of specific provider endpoints.  
* Throws a specific UnknownModelError if the requested canonical string is not in the map.

## **Story 1.5: OmniGateway Multiplexer**

**Overview Description:** Wire the QuotaTracker into the gateway and implement logic to rotate and multiplex keys across "virtual colleagues" during routing.  
**Complexity Score:** 13 (Highly Complex)  
**Dependencies:** Story 1.2, 1.4  
**Developer Guidance:** This is the core engine. It must handle 429 Rate Limits by catching the error, logging it to SugarDB, marking that specific Vault Key as cooling down, and instantly retrying the request with the next key in the pool.

### **Checkbox Tasklist:**

* \[ \] Integrate QuotaTracker.ts to log token usage post-request.  
* \[ \] Implement connection pool rotation logic (round-robin across active Virtual Colleagues).  
* \[ \] Build the error interception loop to catch 429s and trigger instant failovers.

### **Acceptance Criteria:**

* A simulated 429 error from Groq Key 1 seamlessly fails over to Groq Key 2 and returns a successful response to the user without dropping the HTTP connection.

## **Story 1.6: TS Ingress Endpoint**

**Overview Description:** Expose the Node.js OmniGateway via a local HTTP server so the Python layer can communicate with it.  
**Complexity Score:** 3 (Simple)  
**Dependencies:** Story 1.5  
**Developer Guidance:** Use standard Node HTTP or Fastify. This must exactly mirror the OpenAI /v1/chat/completions schema to ensure upstream compatibility.

### **Checkbox Tasklist:**

* \[ \] Setup Fastify server on port 3000\.  
* \[ \] Create POST route parsing standard OpenAI JSON body.  
* \[ \] Pipe request to OmniGateway and return the stream.

### **Acceptance Criteria:**

* A local cURL to http://localhost:3000/v1/chat/completions returns a valid streamed response.

# **EPIC 2: The Memory & Brain**

## **Overview Description**

This epic establishes the Layer 1 Python governance brain and the secondary telemetry database. By utilizing Python and FastAPI, we set the stage for ultra-fast, 1-bit quantized BitNet heuristic evaluations, ensuring that simple tasks bypass the heavy Swarm DAG.

## **Overall Goal**

Create a stable Python ingress that intercepts all local agent traffic, evaluates prompt complexity, logs system telemetry to a dedicated database, and successfully forwards requests to the Node.js egress layer.

## **Story 2.1: SugarDB Telemetry Setup**

**Overview Description:** Set up a secondary SQLite database to log Engram schema drifts, quota warnings, and Judge rejections for future Karpathy-style fine-tuning.  
**Complexity Score:** 3 (Standard Data)  
**Dependencies:** None  
**Developer Guidance:** This database is unencrypted for fast reads/writes. Use PRAGMA WAL mode.

### **Checkbox Tasklist:**

* \[ \] Initialize ./.sugar/telemetry.db using better-sqlite3.  
* \[ \] Write schemas for logs and drift\_events.  
* \[ \] Expose a TelemetryLogger TS class.

### **Acceptance Criteria:**

* System successfully inserts 100 mock events under 10ms.

## **Story 2.2: Python FastAPI Scaffolding**

**Overview Description:** Initialize the Layer 1 Python environment with FastAPI and Pydantic models matching OpenAI specifications.  
**Complexity Score:** 3 (Simple)  
**Dependencies:** None  
**Developer Guidance:** Ensure Pydantic handles the stream: true boolean correctly. Setup CORS to allow localhost connections.

### **Checkbox Tasklist:**

* \[ \] Setup main.py and requirements.txt.  
* \[ \] Create Pydantic models for ChatRequest.  
* \[ \] Launch server on port 8000\.

### **Acceptance Criteria:**

* FastAPI Swagger UI is accessible at http://localhost:8000/docs.

### **Resource URLs:**

* FastAPI: https://fastapi.tiangolo.com/

## **Story 2.3: BitNet Heuristic Stub**

**Overview Description:** Implement the 14-dimension heuristic evaluation logic. For this sprint, use regex/keyword matching before loading actual model weights to test the branching.  
**Complexity Score:** 5 (Medium)  
**Dependencies:** Story 2.2  
**Developer Guidance:** Keep the interface clean so we can swap the Regex stub out for the vLLM BitNet model in v5.1.

### **Checkbox Tasklist:**

* \[ \] Write evaluate\_complexity(prompt) returning "SIMPLE" or "COMPLEX".  
* \[ \] Inject evaluation logic into the FastAPI route.

### **Acceptance Criteria:**

* Prompts containing "decompose" or "architect" route to COMPLEX.

## **Story 2.4: The Forwarding Bridge**

**Overview Description:** Configure FastAPI to forward requests via httpx directly to the Node.js OmniGateway port.  
**Complexity Score:** 5 (Medium)  
**Dependencies:** Story 1.6, 2.3  
**Developer Guidance:** Use httpx.AsyncClient to stream the response chunks directly back to the client without buffering them in Python memory.

### **Checkbox Tasklist:**

* \[ \] Setup httpx client.  
* \[ \] Stream FastAPI response from localhost:3000.

### **Acceptance Criteria:**

* Agents hitting port 8000 receive streamed tokens originating from the TS port 3000\.

# **EPIC 3: Semantic Middleware (Engram)**

## **Overview Description**

This epic implements the core autonomous logic for Deep Swarm tasks. It introduces the Engram engine to decompose complex goals into parallel tasks and, critically, builds the auto-healing JSON middleware to correct open-source model hallucinations.

## **Overall Goal**

Enable robust Swarm DAG decomposition and real-time schema healing without operator intervention.

## **Story 3.1: Engram Drift Corrector**

**Overview Description:** Build the middleware to intercept failed JSON.parse executions, call a fast model to repair syntax, and log the event to SugarDB.  
**Complexity Score:** 8 (Complex)  
**Dependencies:** Story 1.5, 2.1  
**Developer Guidance:** Implement strict timeouts for the healing prompt. If the healing prompt fails, throw a hard error to prevent infinite loops.

### **Checkbox Tasklist:**

* \[ \] Wrap JSON parsing in a resilient try/catch.  
* \[ \] On catch, trigger prompt to Groq/llama3.  
* \[ \] Parse fixed response and log original broken string to SugarDB.

### **Acceptance Criteria:**

* Deliberately mangled JSON is repaired and returned as a valid object.

## **Story 3.2: DAG Engine (Map & Process)**

**Overview Description:** Prompt the Frontier model to decompose a complex task, then use Promise.allSettled to execute parallel swarm tasks concurrently.  
**Complexity Score:** 13 (Highly Complex)  
**Dependencies:** Story 3.1  
**Developer Guidance:** Promise.allSettled is mandatory to prevent a single node failure from crashing the entire DAG.

### **Checkbox Tasklist:**

* \[ \] Write decomposition prompt.  
* \[ \] Spin up async workers based on parsed sub-tasks.  
* \[ \] Aggregate results.

### **Acceptance Criteria:**

* A single "Complex" request triggers N simultaneous outbound requests to the OmniGateway.

# **EPIC 4: Control & Observability (Dual Interface)**

## **Overview Description**

This epic establishes the visual and terminal user interfaces required to govern the Aigency OS. It implements the Textual TUI for keyboard-driven config management and the Three.js Holo-CRT dashboard for visual swarm telemetry.

## **Overall Goal**

Provide the solo developer with zero-latency terminal controls over the SugarVault, alongside a real-time 3D visualization of the swarm's health and routing logic via SSE streams.

## **Story 4.1: TUI Scaffolding (Textual/Typer)**

**Overview Description:** Build the Python command-line app to view live routing logs and manage SugarVault credentials.  
**Complexity Score:** 8 (Complex UI)  
**Dependencies:** Story 1.2  
**Developer Guidance:** Use Textual's Grid layout. Ensure the Vault pane can securely query the SQLite database.

### **Checkbox Tasklist:**

* \[ \] Setup typer CLI entry points.  
* \[ \] Build Textual app with dual panes.  
* \[ \] Connect TUI to SugarVault for key injection.

### **Acceptance Criteria:**

* Running voltron tui launches a responsive terminal UI. Adding a key updates the DB.

### **Resource URLs:**

* Textual Docs: https://textual.textualize.io/

## **Story 4.2: Holo-CRT React/Three.js Canvas**

**Overview Description:** Render the 3D center monolith, provider orbits, and Judge pyramid.  
**Complexity Score:** 13 (Highly Complex \- WebGL)  
**Dependencies:** None  
**Developer Guidance:** Maintain 60fps. Use React Three Fiber and implement post-processing Bloom for the CRT effect.

### **Checkbox Tasklist:**

* \[ \] Setup Vite React app.  
* \[ \] Render Three.js geometries for nodes.  
* \[ \] Consume SSE stream to trigger visual animations (lasers, pulses).

### **Acceptance Criteria:**

* Dashboard renders 3D elements and animates a laser trace when a mock FAST\_TRACK SSE event is received.

### **Resource URLs:**

* Three.js: https://threejs.org/