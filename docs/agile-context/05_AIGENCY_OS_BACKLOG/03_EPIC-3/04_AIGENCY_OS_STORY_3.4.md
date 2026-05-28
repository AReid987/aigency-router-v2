# Story 3.4: The Judge Loop

**Overview Description:** Implement logic to concatenate the swarm outputs, validate them against the original prompt via a Judge model, and trigger a retry loop on rejection.

**Complexity Score:** 8

**Dependencies:** Story 3.3

**Developer Guidance:** Limit the retry loop to a maximum of 3 iterations to prevent runaway token burn. Log all rejections to SugarDB for observability. 

### Checkbox Tasklist:
* [ ] Concatenate swarm outputs into a single review prompt.
* [ ] Call a fast "Judge" model endpoint to output a PASS/FAIL verdict.
* [ ] Implement `while` loop (max 3 retries) if verdict is FAIL.

### Acceptance Criteria:
* A simulated FAIL verdict triggers a re-run of the DAG Process step.
* Reaching 3 failures breaks the loop and returns the best partial output to the user.

### Resource URLs:
* LLM-as-a-Judge concepts: [https://arxiv.org/abs/2306.05685](https://arxiv.org/abs/2306.05685)
