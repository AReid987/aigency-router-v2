# Story 1.5: OmniGateway Multiplexer

**Overview Description:** Wire the QuotaTracker into the gateway and implement logic to rotate and multiplex keys across "virtual colleagues" during routing.

**Complexity Score:** 13 (Highly Complex)

**Dependencies:** Story 1.2, 1.4

**Developer Guidance:** This is the core engine. It must handle 429 Rate Limits by catching the error, logging it to SugarDB, marking that specific Vault Key as cooling down, and instantly retrying the request with the next key in the pool.

### Checkbox Tasklist:
* [ ] Integrate `QuotaTracker.ts` to log token usage post-request.
* [ ] Implement connection pool rotation logic (round-robin across active Virtual Colleagues).
* [ ] Build the error interception loop to catch HTTP 429s and 5xx errors and trigger instant failovers.

### Acceptance Criteria:
* A simulated 429 error from Groq Key 1 seamlessly fails over to Groq Key 2 and returns a successful response to the user without dropping the HTTP connection.