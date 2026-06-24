/**
 * HTTP Handler — iii-engine HTTP trigger endpoints
 *
 * The HTTP handler is integrated directly into Engine.httpHandler() within engine.ts.
 * This file provides the public HTTP API surface for documentation and re-export.
 *
 * ## Endpoints (all on httpPort, default 3000)
 *
 * | Method | Path                   | Route Function              | Description                          |
 * |--------|------------------------|-----------------------------|--------------------------------------|
 * | POST   | /v1/chat/completions  | gateway::chat_completions   | OpenAI-compatible chat completions    |
 * | POST   | *                     | gateway::http (default)     | Generic HTTP trigger routing           |
 * | GET    | /health               | (builtin)                   | Liveness check                        |
 * | GET    | /ready                | (builtin)                   | Readiness (true once HTTP trigger worker registered) |
 * | GET    | /metrics              | (builtin)                   | Structured metrics JSON                |
 * | OPTIONS| *                     | (builtin)                   | CORS preflight                         |
 *
 * ## Path-Specific Routing
 *
 * The engine uses a path → function_id mapping. Workers can register the
 * appropriate function under the expected function_id:
 *
 *   sdk.registerFunction({
 *     id: 'gateway::chat_completions',
 *     handler: async (req) => { ... },
 *   });
 *
 * ## Streaming (SSE)
 *
 * SSE is supported via channels. The worker sends:
 *   { type: 'set_status', status_code: 200 }
 *   { type: 'set_headers', headers: { 'content-type': 'text/event-stream' } }
 *   <binary SSE chunks>
 *
 * Workers register HTTP trigger capability by calling:
 *   sdk.registerTriggerType({ id: 'http' })
 *   sdk.registerTrigger({ id: 'http-gateway', type: 'http', function_id: 'gateway::http' })
 *
 * ## Usage (programmatic)
 *
 * \ *
 * ## Usage (CLI)
 *
 * \ */

// Re-export Engine for convenience — HTTP handler is part of the Engine class
export { Engine } from './engine.js';
export type { EngineOptions } from './engine.js';
