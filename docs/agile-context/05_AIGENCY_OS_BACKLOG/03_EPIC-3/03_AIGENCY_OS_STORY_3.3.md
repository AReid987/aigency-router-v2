# Story 3.3: DAG Engine (Process)

**Overview Description:** Execute the array of decomposed sub-tasks concurrently across the multiplexed key pool.

**Complexity Score:** 13

**Dependencies:** Story 3.2

**Developer Guidance:** `Promise.allSettled` is absolutely mandatory here. Standard `Promise.all` will crash the entire swarm if a single node fails or times out. We need to aggregate successes and handle individual node rejections gracefully.

### Checkbox Tasklist:
* [ ] Map the `SubTask` array to an array of async `OmniGateway.fetch()` calls.
* [ ] Wrap in `Promise.allSettled()`.
* [ ] Filter fulfilled promises and extract generated text.

### Acceptance Criteria:
* The system executes 5 simultaneous sub-tasks, successfully aggregating 4 successful responses even if 1 sub-task throws a network timeout.

### Resource URLs:
* Promise.allSettled: [https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled)
