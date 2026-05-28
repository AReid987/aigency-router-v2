# Story 4.3: SSE Backend Streaming

**Overview Description:** Update both Python and Node.js backends to yield Server-Sent Events (SSE) that feature `aigency_telemetry` chunks embedded alongside standard OpenAI tokens.

**Complexity Score:** 5

**Dependencies:** Story 1.6, Story 2.4

**Developer Guidance:** The telemetry chunk must use a distinct schema so the Holo-CRT dashboard can parse it out, while CLI agents simply ignore it.

### Checkbox Tasklist:
* [ ] Update Node.js OmniGateway to push telemetry state objects into the chunk stream.
* [ ] Ensure Python FastAPI `httpx` proxy forwards these specific chunks cleanly.
* [ ] Create TypeScript interfaces for `TelemetryChunk`.

### Acceptance Criteria:
* A cURL request with `stream: true` returns OpenAI text chunks interleaved with `{"aigency_telemetry": {...}}` chunks.

### Resource URLs:
* Server-Sent Events (MDN): [https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
