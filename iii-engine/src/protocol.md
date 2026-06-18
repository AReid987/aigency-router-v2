# III Engine WebSocket Protocol

## Overview

The `iii` engine is a WebSocket server that routes IPC calls between workers.
Workers connect via `registerWorker(url, { workerName })` from `iii-sdk`.

## Message Types

All messages are JSON objects with a `message_type` field.

### Worker → Engine

| message_type | Description |
|---|---|
| `registerfunction` | Worker registers a callable function |
| `unregisterfunction` | Worker unregisters a function |
| `registertriggertype` | Worker registers a trigger type (e.g. `http`, `cron`) |
| `registertrigger` | Worker registers a trigger instance |
| `unregistertrigger` | Worker unregisters a trigger |
| `invocationresult` | Worker returns the result of a function call |

### Engine → Worker

| message_type | Description |
|---|---|
| `workerregistered` | Engine acknowledges worker connection |
| `invokefunction` | Engine asks worker to execute a function |
| `triggerregistrationresult` | Engine confirms trigger registration |

## Message Schemas

### RegisterFunction (worker → engine)
```json
{
  "message_type": "registerfunction",
  "id": "gateway::route_llm",
  "description": "Routes LLM requests to the appropriate provider",
  "request_format": { ... },
  "response_format": { ... },
  "metadata": {}
}
```

### InvokeFunction (engine → worker)
```json
{
  "message_type": "invokefunction",
  "id": "uuid-v4",
  "function_id": "gateway::route_llm",
  "payload": { ... }
}
```

### InvocationResult (worker → engine)
```json
{
  "message_type": "invocationresult",
  "id": "uuid-v4",
  "result": { ... }
}
```

### WorkerRegistered (engine → worker)
```json
{
  "message_type": "workerregistered",
  "worker_id": "gateway",
  "worker_name": "gateway"
}
```

## Built-in Engine Functions

Workers can call these without registering first:
- `engine::functions::list` — list all registered functions
- `engine::workers::list` — list all connected workers
- `engine::triggers::list` — list trigger types

## Shutdown

On SIGTERM, the engine:
1. Stops accepting new WebSocket connections
2. Waits for in-flight invocations to complete (with timeout)
3. Closes all worker connections
4. Exits 0
