# Story 2.3: BitNet Heuristic Stub

**Overview Description:** Implement the 14-dimension heuristic evaluation logic. For this sprint, use regex/keyword matching to stub out the logic before loading the actual 1-bit model weights in v5.1.

**Complexity Score:** 5

**Dependencies:** Story 2.2

**Developer Guidance:** Keep the interface clean. The `evaluate_complexity()` function should act as a pure black box so we can seamlessly swap the Regex stub out for the vLLM BitNet tensor operations later without changing the routing logic.

### Checkbox Tasklist:
* [ ] Write `evaluate_complexity(prompt)` returning strictly "SIMPLE" or "COMPLEX".
* [ ] Inject evaluation logic into the FastAPI ingress route.

### Acceptance Criteria:
* Prompts containing code-generation keywords ("decompose", "architect", "refactor", "system") route to `COMPLEX`.
* General conversational prompts route to `SIMPLE`.

### Resource URLs:
* Python re module: [https://docs.python.org/3/library/re.html](https://docs.python.org/3/library/re.html)
