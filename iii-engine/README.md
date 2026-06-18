# III Engine

WebSocket IPC hub that all workers connect to via `iii-sdk`. Routes function
calls, manages trigger registration, bridges HTTP requests to workers via
channels, and tracks per-call SLA metrics.

## Quick Start

```bash
cd iii-engine
npm install
npm start    # starts engine on ws://127.0.0.1:49134 (workers, HTTP API, and channels all share this port)
```

## Single-Port Design

The engine listens on ONE port for everything:
- Worker WebSocket connections (path `/`, `/ws`, `/otel`, etc.)
- HTTP API (path `/health`, `/ready`, `/metrics`, `/v1/chat/completions`, etc.)
- Channel WebSocket connections (path `/ws/channels/:channel_id`)

This matches what `iii-sdk` expects: the SDK's `buildChannelUrl()` derives
the channel URL from the same base as the worker connection URL.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `WS_PORT` | 49134 | Single port for workers + HTTP API + channels |
| `III_URL` | ws://127.0.0.1:49134 | Default URL workers use (set in workers) |

## HTTP Endpoints

- `GET /health` — liveness, returns `{ status: 'ok' }`
- `GET /ready` — readiness, returns 200 if at least one HTTP trigger worker is connected
- `GET /metrics` — engine stats + SLA (per-function calls, errors, timeouts, latency buckets)
- `POST/GET /*` — routed to worker that registered an `http` trigger

## HTTP Routing Protocol

When an HTTP request arrives at the engine:
1. Engine finds a worker with an `http` trigger
2. Engine creates a channel (writer key + reader key)
3. Engine sends `invokefunction` with payload `{ path, method, headers, body, query_params, path_params, request_body, response: StreamChannelRef }`
4. The SDK's `http()` wrapper resolves `response` to a `ChannelWriter` (which connects to the channel as a writer)
5. Worker writes status, headers, and body to the channel
6. Engine reads the channel and forwards to the HTTP response
7. When the writer closes, the engine sends the HTTP response and closes

## Built-in Engine Functions

| function_id | Description |
|---|---|
| `engine::workers::register` | Worker self-registration with name/runtime/metadata |
| `engine::workers::list` | List all connected workers |
| `engine::functions::list` | List all registered functions |
| `engine::triggers::list` | List all registered trigger types |
| `engine::registered-triggers::list` | List all registered trigger instances |
| `engine::channels::create` | Create a streaming channel, returns `{writer, reader}` refs |

## Tests

```bash
npm test
```

19/19 tests pass:
- WebSocket connection + auto-registration
- Function registration and routing
- Invocation with result/timeout
- HTTP trigger routing (channel protocol)
- HTTP streaming chunks (SSE)
- Health/Ready/Metrics endpoints
- Real `iii-sdk` integration
- Real gateway worker integration
- Graceful shutdown
- SLA tracking per function

## Wire Format Notes

Workers send messages with `type` field (NOT `message_type`):
```json
{ "type": "registerfunction", "id": "...", "description": "..." }
```

The SDK's `toWireFormat()` converts `message_type` → `type` for the wire.
The engine matches this on both send and receive.
