import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  Distributor,
  AggregatedDispatchError,
  type PoolWorker,
  type DistributorWorkerPool,
} from './distributor.ts'
import { type RunnableDag } from './parallel_scheduler.ts'
import { type TelemetryDeps } from '../../shared/telemetry.ts'

// ── Helpers ────────────────────────────────────────────────────────────

function makeWorker(id: string, capabilities: string[], failFor?: string[]): PoolWorker {
  return {
    id,
    getCapabilities: () => capabilities,
    async run(task) {
      if (failFor?.includes(task.id)) {
        throw new Error(`${id} cannot handle ${task.id}`)
      }
      // Return the actual task execution result, not a synthetic value
      return task.execute()
    },
  }
}

function makePool(workers: PoolWorker[]): DistributorWorkerPool & { errorLog: string[] } {
  const errorLog: string[] = []
  return {
    getWorkers: () => workers,
    markError: (wid: string) => { errorLog.push(wid) },
    errorLog,
  }
}

function node(
  id: string,
  depends_on: string[] = [],
  result?: unknown,
  capability?: string,
): { id: string; depends_on: string[]; required_capability?: string; execute: () => Promise<unknown> } {
  return {
    id,
    depends_on,
    required_capability: capability,
    async execute() {
      return result ?? `result-${id}`
    },
  }
}

/** Create a mock TelemetryDeps that captures events. */
function mockTelemetryDeps(): { deps: TelemetryDeps; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = []
  return {
    deps: {
      async trigger(_target: string, _fn: string, input: unknown) {
        events.push(input as Record<string, unknown>)
      },
    },
    events,
  }
}

// ── Capability matching ────────────────────────────────────────────────

describe('Distributor — capability matching', () => {
  it('routes node to worker with matching capability', async () => {
    const workers = [makeWorker('w1', ['nlp']), makeWorker('w2', ['vision'])]
    const dag: RunnableDag = {
      nodes: [node('n1', [], 'ok', 'nlp')],
    }
    const p = makePool(workers)
    const d = new Distributor(dag, p, 3)
    const results = await d.aggregate()
    assert.equal(results.get('n1'), 'ok')
  })

  it('routes to first capable worker when multiple match (LRU)', async () => {
    const workers = [
      makeWorker('w1', ['nlp']),
      makeWorker('w2', ['nlp']),
      makeWorker('w3', ['vision']),
    ]
    const dag: RunnableDag = {
      nodes: [
        node('n1', [], 'a', 'nlp'),
        node('n2', [], 'b', 'nlp'),
      ],
    }
    const p = makePool(workers)
    const d = new Distributor(dag, p, 3)
    const results = await d.aggregate()
    // Both should succeed regardless of which worker handled them
    assert.equal(results.get('n1'), 'a')
    assert.equal(results.get('n2'), 'b')
  })

  it('throws when no worker has the required capability', async () => {
    const workers = [makeWorker('w1', ['vision'])]
    const dag: RunnableDag = {
      nodes: [node('n1', [], 'fail', 'nlp')],  // nlp not available
    }
    const p = makePool(workers)
    const d = new Distributor(dag, p, 3)

    await assert.rejects(
      () => d.aggregate(),
      (err: unknown) =>
        err instanceof AggregatedDispatchError &&
        err.nodeId === 'n1',
    )
  })

  it('handles node without required_capability', async () => {
    const workers = [makeWorker('w1', ['any'])]
    const dag: RunnableDag = {
      nodes: [node('n1', [], 'no-cap')],  // no required_capability
    }
    const p = makePool(workers)
    const d = new Distributor(dag, p, 3)
    const results = await d.aggregate()
    assert.equal(results.get('n1'), 'no-cap')
  })
})

// ── LRU tie-breaking ───────────────────────────────────────────────────

describe('Distributor — LRU tie-breaking', () => {
  it('distributes across matching workers round-robin-ish by LRU', async () => {
    const workers = [
      makeWorker('a', ['nlp']),
      makeWorker('b', ['nlp']),
      makeWorker('c', ['vision']),
    ]
    const dag: RunnableDag = {
      nodes: [
        node('n1', [], 'first', 'nlp'),
        node('n2', [], 'second', 'nlp'),
        node('n3', [], 'third', 'nlp'),
      ],
    }
    const p = makePool(workers)

    // Track which worker ran which task
    const assignments: [string, string][] = []
    const trackedWorkers = workers.map((w) => ({
      ...w,
      run: async (task: any) => {
        assignments.push([task.id, w.id])
        return w.run(task)
      },
    }))

    const pool: DistributorWorkerPool = {
      getWorkers: () => trackedWorkers,
      markError: (wid: string) => p.markError(wid),
    }

    const d = new Distributor(dag, pool, 3)
    await d.aggregate()

    // a and b are the only nlp-capable workers; c shouldn't be used
    const usedWorkers = new Set(assignments.map(([, w]) => w))
    assert.ok(usedWorkers.has('a'))
    assert.ok(usedWorkers.has('b'))
    assert.equal(usedWorkers.has('c'), false)

    // All 3 nodes should be assigned to a or b in some LRU order
    assert.equal(assignments.length, 3)
  })
})

// ── Retry logic ────────────────────────────────────────────────────────

describe('Distributor — retry', () => {
  it('retries failed node on next-best worker', async () => {
    // w1 has 'nlp' and fails for n1; w2 also has 'nlp' and should pick it up
    const workers = [
      makeWorker('w1', ['nlp'], ['n1']),
      makeWorker('w2', ['nlp']),
    ]
    const dag: RunnableDag = {
      nodes: [node('n1', [], 'retried', 'nlp')],
    }
    const p = makePool(workers)
    const d = new Distributor(dag, p, 3)
    const results = await d.aggregate()
    assert.equal(results.get('n1'), 'retried')
    assert.deepEqual(p.errorLog, ['w1'])  // w1 marked as error
  })

  it('retries across workers until retryCap is exhausted then throws', async () => {
    // Both nlp workers fail for n1
    const workers = [
      makeWorker('w1', ['nlp'], ['n1']),
      makeWorker('w2', ['nlp'], ['n1']),
    ]
    const dag: RunnableDag = {
      nodes: [node('n1', [], null, 'nlp')],
    }
    const p = makePool(workers)
    // retryCap=1 means 1 retry = 2 total attempts (w1 then w2)
    const d = new Distributor(dag, p, 1)

    await assert.rejects(
      () => d.aggregate(),
      (err: unknown) =>
        err instanceof AggregatedDispatchError &&
        err.nodeId === 'n1' &&
        err.attempts === 2,
    )
  })

  it('respects retryCap=0 (no retries)', async () => {
    const workers = [
      makeWorker('w1', ['nlp'], ['n1']),
      makeWorker('w2', ['nlp']),
    ]
    const dag: RunnableDag = {
      nodes: [node('n1', [], null, 'nlp')],
    }
    const p = makePool(workers)
    // retryCap=0 → no retries, fails immediately
    const d = new Distributor(dag, p, 0)

    await assert.rejects(
      () => d.aggregate(),
      (err: unknown) =>
        err instanceof AggregatedDispatchError &&
        err.nodeId === 'n1' &&
        err.attempts === 1,
    )
  })
})

// ── Streaming generator ────────────────────────────────────────────────

describe('Distributor — streaming generator', () => {
  it('yields results as workers complete', async () => {
    const workers = [makeWorker('w1', ['nlp'])]
    const dag: RunnableDag = {
      nodes: [
        node('a', [], 'A', 'nlp'),
        node('b', [], 'B', 'nlp'),
        node('c', [], 'C', 'nlp'),
      ],
    }
    const p = makePool(workers)
    const d = new Distributor(dag, p, 3)

    const yielded: string[] = []
    for await (const { node_id } of d.distribute()) {
      yielded.push(node_id)
    }

    // All 3 should be yielded, regardless of order
    assert.equal(yielded.length, 3)
    assert.ok(yielded.includes('a'))
    assert.ok(yielded.includes('b'))
    assert.ok(yielded.includes('c'))
  })

  it('aggregate() produces correct Map from generator', async () => {
    const workers = [makeWorker('w1', ['nlp'])]
    const dag: RunnableDag = {
      nodes: [
        node('x', [], 10, 'nlp'),
        node('y', ['x'], 20, 'nlp'),
        node('z', ['x'], 30, 'nlp'),
      ],
    }
    const p = makePool(workers)
    const d = new Distributor(dag, p, 3)
    const results = await d.aggregate()

    assert.equal(results.size, 3)
    assert.equal(results.get('x'), 10)
    assert.equal(results.get('y'), 20)
    assert.equal(results.get('z'), 30)
  })
})

// ── Telemetry ──────────────────────────────────────────────────────────

describe('Distributor — telemetry', () => {
  it('emits TASK_DISPATCHED and TASK_AGGREGATED per node', async () => {
    const workers = [makeWorker('w1', ['nlp'])]
    const dag: RunnableDag = {
      nodes: [node('n1', [], 'ok', 'nlp')],
    }
    const p = makePool(workers)
    const { deps, events } = mockTelemetryDeps()
    const d = new Distributor(dag, p, 3, deps)

    await d.aggregate()

    // Should have 2 events: DISPATCHED + AGGREGATED
    assert.equal(events.length, 2)

    const dispatched = events.find((e: any) => e.eventClass === 'TASK_DISPATCHED') as any
    const aggregated = events.find((e: any) => e.eventClass === 'TASK_AGGREGATED') as any

    assert.ok(dispatched, 'Expected TASK_DISPATCHED event')
    assert.ok(aggregated, 'Expected TASK_AGGREGATED event')

    assert.equal(dispatched.payload.node_id, 'n1')
    assert.equal(dispatched.payload.worker_id, 'w1')
    assert.equal(dispatched.payload.attempt, 0)
    assert.equal(dispatched.sourceWorker, 'distributor')

    assert.equal(aggregated.payload.node_id, 'n1')
    assert.equal(aggregated.payload.worker_id, 'w1')
    assert.equal(aggregated.sourceWorker, 'distributor')
  })

  it('emits correct telemetry on retry (dispatched per attempt)', async () => {
    const workers = [
      makeWorker('w1', ['nlp'], ['n1']),
      makeWorker('w2', ['nlp']),
    ]
    const dag: RunnableDag = {
      nodes: [node('n1', [], 'ok', 'nlp')],
    }
    const p = makePool(workers)
    const { deps, events } = mockTelemetryDeps()
    const d = new Distributor(dag, p, 3, deps)

    await d.aggregate()

    // 3 events: DISPATCHED (w1), DISPATCHED (w2), AGGREGATED (w2)
    const dispatched = events.filter((e: any) => e.eventClass === 'TASK_DISPATCHED')
    const aggregated = events.filter((e: any) => e.eventClass === 'TASK_AGGREGATED')

    assert.equal(dispatched.length, 2)
    assert.equal(aggregated.length, 1)

    assert.equal((dispatched[0] as any).payload.worker_id, 'w1')
    assert.equal((dispatched[0] as any).payload.attempt, 0)
    assert.equal((dispatched[1] as any).payload.worker_id, 'w2')
    assert.equal((dispatched[1] as any).payload.attempt, 1)
  })
})

// ── Error cases ────────────────────────────────────────────────────────

describe('Distributor — error cases', () => {
  it('throws if no worker available', async () => {
    const dag: RunnableDag = {
      nodes: [node('n1', [], 'x', 'nlp')],
    }
    const p = makePool([])  // empty pool
    const d = new Distributor(dag, p, 3)

    await assert.rejects(
      () => d.aggregate(),
      (err: unknown) =>
        err instanceof AggregatedDispatchError &&
        err.nodeId === 'n1' &&
        err.attempts === 0,
    )
  })

  it('propagates error after all workers exhausted in a multi-node DAG', async () => {
    const workers = [
      makeWorker('w1', ['nlp'], ['n2']),
    ]
    const dag: RunnableDag = {
      nodes: [
        node('n1', [], 'ok', 'nlp'),
        node('n2', [], null, 'nlp'),  // will fail
      ],
    }
    const p = makePool(workers)
    const d = new Distributor(dag, p, 0)

    await assert.rejects(
      () => d.aggregate(),
      AggregatedDispatchError,
    )
  })
})
