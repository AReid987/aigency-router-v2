# Story 3.2: DAG Engine (Map)

**Overview Description:** Prompt a Frontier-class model to decompose a complex user request into a strict JSON array of parallelizable sub-tasks.

**Complexity Score:** 8

**Dependencies:** Story 3.1

**Developer Guidance:** Enforce strict JSON schema compliance via the provider's API (e.g., Groq JSON mode) if supported. Use the Engram Drift Corrector (3.1) as a fallback if the Frontier model hallucinates the decomposition array.

### Checkbox Tasklist:
* [ ] Create system prompts for "Task Decomposition".
* [ ] Build the TypeScript function `decomposeTask(prompt: string)`.
* [ ] Return an array of standardized `SubTask` interface objects.

### Acceptance Criteria:
* A prompt asking for a "full-stack authentication module" successfully maps to an array of at least 3 sub-tasks (e.g., DB Schema, Backend Route, Frontend Form).

### Resource URLs:
* Directed Acyclic Graphs (DAGs): [https://en.wikipedia.org/wiki/Directed_acyclic_graph](https://en.wikipedia.org/wiki/Directed_acyclic_graph)
