/**
 * HTTP Handler — iii-engine HTTP trigger endpoints
 *
 * The HTTP handler is integrated directly into Engine.httpHandler() within engine.ts.
 * This file provides the public HTTP API surface for documentation and re-export.
 *
 * ## Endpoints (all on httpPort, default 3000)
 *
 * | Method | Path                   | Auth | Description                          |
 * |--------|------------------------|------|--------------------------------------|
 * | POST   | /v1/chat/completions  | -    | Route to gateway::http trigger (via channel) |
 * | GET    | /health               | -    | Liveness check                        |
 * | GET    | /ready                | -    | Readiness (true once HTTP trigger worker registered) |
 * | GET    | /metrics              | -    | Structured metrics JSON                |
 * | OPTIONS| *                     | -    | CORS preflight                         |
 *
 * ## POST /v1/chat/completions
 *
 * Accepts the OpenAI-compatible chat completions body. Creates a channel and routes
 * to the registered gateway::http trigger via the worker's HTTP trigger handler.
 * The worker writes its response (status codes, headers, body chunks) back to the
 * channel; this handler reads those chunks and forwards them to the HTTP client.
 *
 * Workers register HTTP trigger capability by calling:
 *   sdk.registerTriggerType({ id: 'http' })
 *   sdk.registerTrigger({ id: 'http-gateway', type: 'http', function_id: 'gateway::http' })
 *
 * ## Streaming (SSE)
 *
 * SSE is supported via channels. The worker sends:
 *   { type: 'set_status', status_code: 200 }
 *   { type: 'set_headers', headers: { 'content-type': 'text/event-stream' } }
 *   <binary SSE chunks>
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
