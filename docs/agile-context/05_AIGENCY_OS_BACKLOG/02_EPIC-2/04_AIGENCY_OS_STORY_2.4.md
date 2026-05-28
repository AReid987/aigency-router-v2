# Story 2.4: The Forwarding Bridge

**Overview Description:** Configure FastAPI to forward requests via `httpx` directly to the Node.js OmniGateway port based on the heuristic classification.

**Complexity Score:** 5

**Dependencies:** Story 1.6, Story 2.3

**Developer Guidance:** Use `httpx.AsyncClient`. It is critical to stream the response chunks directly back to the client as they arrive from Node.js, rather than buffering them in Python memory, to maintain sub-150ms TTFT (Time To First Token).

### Checkbox Tasklist:
* [ ] Setup `httpx` async client in `main.py`.
* [ ] Implement streaming proxy logic pointing to `http://localhost:3000/v1/chat/completions`.

### Acceptance Criteria:
* Agents hitting port 8000 receive streamed tokens originating from the TypeScript port 3000 without artificial buffering delays.

### Resource URLs:
* httpx Async: [https://www.python-httpx.org/async/](https://www.python-httpx.org/async/)
