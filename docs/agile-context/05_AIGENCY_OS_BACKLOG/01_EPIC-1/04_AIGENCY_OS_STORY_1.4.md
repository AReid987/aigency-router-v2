# Story 1.4: ModelTranslator Middleware

**Overview Description:** Implement canonical grouping logic to map generic agent requests into provider-specific arrays based on Quality of Service (QoS).

**Complexity Score:** 5 (Medium)

**Dependencies:** Story 1.3

**Developer Guidance:** This is a pure data-transformation layer. If the input is `llama3`, the output should be `['groq/llama3-8b-8192', 'cerebras/llama3.1-8b']`. Store these mappings in a configuration JSON that can be hot-reloaded without restarting the server.

### Checkbox Tasklist:
* [ ] Define `canonical_maps.json`.
* [ ] Create `ModelTranslator.ts` class with a `resolve(canonicalName: string)` method.
* [ ] Write Jest tests validating fallback mapping order.

### Acceptance Criteria:
* Given a canonical string, the middleware returns a valid array of specific provider endpoints.
* Throws a specific `UnknownModelError` if the requested canonical string is not in the map.