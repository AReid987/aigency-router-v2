# III Engine

WebSocket IPC hub that all workers connect to via `iii-sdk`. Routes function
calls, manages trigger registration, and bridges HTTP requests to workers.

## Quick Start

```bash
cd iii-engine
npm install
npm start    # starts engine on ws://127.0.0.1:49134 and http://127.0.0.1:3000
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `WS_PORT` | 49134 | WebSocket port for workers |
| `HTTP_PORT` | 3000 | HTTP port for client requests |

## Endpoints

- `GET /health` — liveness, returns `{ status: 'ok' }`
- `GET /ready` — readiness, returns 200 if at least one HTTP trigger worker is connected
- `GET /metrics` — engine stats (worker count, function count, in-flight calls)
- `POST/GET /*` — routed to worker that registered an `http` trigger

## Wire Protocol

See [src/protocol.md](src/protocol.md) for the full message schema.

Key points:
- Workers connect via `iii-sdk` `registerWorker(url, { workerName })`
- Engine auto-creates a `WorkerInfo` on connect with a temp ID
- Workers then send `registerfunction`, `registertriggertype`, `registertrigger` to register handlers
- Workers call `engine::workers::register` to set their `workerName` and metadata
- Engine responds with `workerregistered` containing the `worker_id`

## Built-in Engine Functions

| function_id | Description |
|---|---|
| `engine::workers::register` | Worker self-registration with name/runtime/metadata |
| `engine::workers::list` | List all connected workers |
| `engine::functions::list` | List all registered functions |
| `engine::triggers::list` | List all registered trigger types |
| `engine::registered-triggers::list` | List all registered trigger instances |

## Tests

```bash
npm test
```

13/13 tests pass:
- WebSocket connection + auto-registration
- Function registration and routing
- Invocation with result/timeout
- HTTP trigger routing
- Health/Ready/Metrics endpoints
- Real `iii-sdk` integration
- Graceful shutdown
