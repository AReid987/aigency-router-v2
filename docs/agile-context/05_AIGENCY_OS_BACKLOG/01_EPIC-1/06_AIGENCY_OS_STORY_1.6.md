# Story 1.6: TS Ingress Endpoint

**Overview Description:** Expose the Node.js OmniGateway via a local HTTP server so the Python layer can communicate with it.

**Complexity Score:** 3 (Simple)

**Dependencies:** Story 1.5

**Developer Guidance:** Use standard Node HTTP or Fastify. This must exactly mirror the OpenAI `/v1/chat/completions` schema to ensure upstream compatibility when Python forwards the payload.

### Checkbox Tasklist:
* [ ] Setup Fastify server on port 3000.
* [ ] Create POST route parsing standard OpenAI JSON body.
* [ ] Pipe request to OmniGateway and return the SSE stream chunks.

### Acceptance Criteria:
* A local cURL to `http://localhost:3000/v1/chat/completions` returns a valid streamed response.

### Resource URLs:
* Fastify Docs: [https://fastify.dev/docs/latest/](https://fastify.dev/docs/latest/)