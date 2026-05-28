# Story 3.1: Engram Drift Corrector

**Overview Description:** Build the middleware to intercept failed `JSON.parse` executions from open-source models, call a fast model to repair the syntax, and log the event.

**Complexity Score:** 8

**Dependencies:** Story 1.5, Story 2.1

**Developer Guidance:** Implement strict timeouts for the healing prompt. If the healing model also hallucinated and fails to provide valid JSON, throw a hard error and abort. Do not allow infinite healing loops.

### Checkbox Tasklist:
* [ ] Wrap upstream JSON parsing in a resilient try/catch block.
* [ ] On catch, trigger a strict JSON-repair system prompt to the fastest active Groq node.
* [ ] Parse the fixed response and log the original broken string to SugarDB.

### Acceptance Criteria:
* Deliberately mangled JSON payloads are repaired mid-flight and returned to the agent as valid objects.
* Event is logged in SugarDB with the tag `DRIFT_HEALED`.

### Resource URLs:
* JSON Error Handling in TS: [https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse)
