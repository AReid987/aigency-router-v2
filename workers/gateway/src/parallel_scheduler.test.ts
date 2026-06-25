import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ParallelScheduler,
  computeStages,
  type RunnableNode,
  type RunnableDag,
  type WorkerPool,
} from './parallel_scheduler.ts'

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a mock worker pool with optional per-task delay. */
function mockPool(delayMs: number = 0): {
  pool: WorkerPool
  runCount: () => number
  slots: Map<string, { start: number; end: number }>
} {
  let _runCount = 0
  const slots = new Map<string, { start: number; end: number }>()
  const pool: WorkerPool = {
    async run(task) {
      _runCount++
      const start = Date.now()
      try {
        return await task.execute()
      } finally {
        slots.set(task.id, { start, end: Date.now() })
      }
    },
    getCapabilities() {
      return []
    },
  }
  return {
    pool,
    runCount: () => _runCount,
    slots,
  }
}

function node(
  id: string,
  depends_on: string[],
  delayMs: number = 0,
  result?: unknown,
): RunnableNode {
  return {
    id,
    depends_on,
    async execute() {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return result ?? `result-${id}`
    },
  }
}

// ── computeStages ──────────────────────────────────────────────────────

describe('computeStages', () => {
  it('groups independent nodes into a single stage', () => {
    const stages = computeStages([node('a', []), node('b', []), node('c', [])])
    assert.equal(stages.length, 1)
    assert.equal(stages[0].length, 3)
    const ids = stages[0].map((n) => n.id).sort()
    assert.deepEqual(ids, ['a', 'b', 'c'])
  })

  it('produces correct ordering for linear chain', () => {
    const stages = computeStages([node('a', []), node('b', ['a']), node('c', ['b'])])
    assert.equal(stages.length, 3)
    assert.deepEqual(stages[0].map((n) => n.id), ['a'])
    assert.deepEqual(stages[1].map((n) => n.id), ['b'])
    assert.deepEqual(stages[2].map((n) => n.id), ['c'])
  })

  it('handles fan-out: root then parallel children', () => {
    const stages = computeStages([
      node('root', []),
      node('b', ['root']),
      node('c', ['root']),
      node('d', ['root']),
    ])
    assert.equal(stages.length, 2)
    assert.deepEqual(stages[0].map((n) => n.id), ['root'])
    assert.deepEqual(stages[1].map((n) => n.id).sort(), ['b', 'c', 'd'])
  })

  it('handles fan-in: parallel roots converge on one', () => {
    const stages = computeStages([
      node('a', []),
      node('b', []),
      node('c', ['a', 'b']),
    ])
    assert.equal(stages.length, 2)
    assert.deepEqual(stages[0].map((n) => n.id).sort(), ['a', 'b'])
    assert.deepEqual(stages[1].map((n) => n.id), ['c'])
  })

  it('handles diamond: a -> {b,c} -> d', () => {
    const stages = computeStages([
      node('a', []),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ])
    assert.equal(stages.length, 3)
    assert.deepEqual(stages[0].map((n) => n.id), ['a'])
    assert.deepEqual(stages[1].map((n) => n.id).sort(), ['b', 'c'])
    assert.deepEqual(stages[2].map((n) => n.id), ['d'])
  })

  it('throws on unknown dependency', () => {
    assert.throws(
      () => computeStages([node('a', ['nonexistent'])]),
      /depends on unknown node/,
    )
  })

  it('throws on cycle', () => {
    assert.throws(
      () => computeStages([node('a', ['b']), node('b', ['a'])]),
      /cycle/,
    )
  })

  it('throws on duplicate ids', () => {
    assert.throws(
      () => computeStages([node('x', []), node('x', [])]),
      /Duplicate node id/,
    )
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(computeStages([]), [])
  })
})

// ── ParallelScheduler ──────────────────────────────────────────────────

describe('ParallelScheduler', () => {
  it('executes a single-node DAG and returns its result', async () => {
    const n = node('n0', [], 0, 42)
    const dag: RunnableDag = { nodes: [n] }
    const { pool } = mockPool()
    const scheduler = new ParallelScheduler(dag, pool, 4)
    const results = await scheduler.run()
    assert.equal(results.size, 1)
    assert.equal(results.get('n0'), 42)
  })

  it('executes a linear chain sequentially', async () => {
    const order: string[] = []
    const n0: RunnableNode = {
      id: 'n0',
      depends_on: [],
      async execute() {
        order.push('n0')
        return 0
      },
    }
    const n1: RunnableNode = {
      id: 'n1',
      depends_on: ['n0'],
      async execute() {
        order.push('n1')
        return 1
      },
    }
    const n2: RunnableNode = {
      id: 'n2',
      depends_on: ['n1'],
      async execute() {
        order.push('n2')
        return 2
      },
    }
    const dag: RunnableDag = { nodes: [n0, n1, n2] }
    const { pool } = mockPool()
    const scheduler = new ParallelScheduler(dag, pool, 4)
    const results = await scheduler.run()
    assert.deepEqual(order, ['n0', 'n1', 'n2'])
    assert.equal(results.get('n2'), 2)
  })

  it('runs parallel nodes concurrently (wall-clock < sum of delays)', async () => {
    // Three nodes with no deps, each taking 100ms
    const dag: RunnableDag = {
      nodes: [node('a', [], 100), node('b', [], 100), node('c', [], 100)],
    }
    const { pool, slots } = mockPool()

    const scheduler = new ParallelScheduler(dag, pool, 4)
    const start = Date.now()
    await scheduler.run()
    const elapsed = Date.now() - start

    // Serial would be 300ms; parallel should be ~100ms
    assert.ok(elapsed < 250, `Expected <250ms for parallel execution, got ${elapsed}ms`)

    // Verify all three slots overlapped
    const times = [...slots.values()]
    const earliestStart = Math.min(...times.map((t) => t.start))
    const latestEnd = Math.max(...times.map((t) => t.end))
    const totalSpan = latestEnd - earliestStart
    assert.ok(totalSpan < 250, `Total span ${totalSpan}ms suggests sequential execution`)
  })

  it('respects max_parallelism cap', async () => {
    // 10 nodes with 50ms delay, cap at 3
    const nodes: RunnableNode[] = []
    for (let i = 0; i < 10; i++) {
      nodes.push(node(`n${i}`, [], 50))
    }
    const dag: RunnableDag = { nodes }
    const { pool } = mockPool()

    const scheduler = new ParallelScheduler(dag, pool, 3)
    const start = Date.now()
    await scheduler.run()
    const elapsed = Date.now() - start

    // With cap=3: ceil(10/3)=4 rounds x 50ms = ~200ms (plus overhead)
    // Serial would be 10*50=500ms, so we should be well under 500ms
    // but comfortably over 50ms (true parallel)
    assert.ok(elapsed > 100, `Expected >100ms (at least 2 rounds), got ${elapsed}ms`)
    assert.ok(elapsed < 450, `Expected <450ms (well under serial 500ms), got ${elapsed}ms`)
  })

  it('emits stage telemetry events with correct payload', async () => {
    const dag: RunnableDag = {
      nodes: [node('a', []), node('b', ['a']), node('c', ['b'])],
    }
    const { pool } = mockPool()

    const events: Record<string, unknown>[] = []
    const origLog = console.log
    console.log = (msg: string) => {
      try {
        events.push(JSON.parse(msg))
      } catch {
        /* skip non-JSON */
      }
    }

    try {
      const scheduler = new ParallelScheduler(dag, pool, 4)
      await scheduler.run()

      // Should have 6 events: started+completed for each of 3 stages
      assert.equal(events.length, 6)

      const started = events.filter((e) => e.event === 'DAG_STAGE_STARTED')
      const completed = events.filter((e) => e.event === 'DAG_STAGE_COMPLETED')
      assert.equal(started.length, 3)
      assert.equal(completed.length, 3)

      // Stage 0 should have 'a', stage 1 'b', stage 2 'c'
      assert.deepEqual(started[0].stage, ['a'])
      assert.deepEqual(started[1].stage, ['b'])
      assert.deepEqual(started[2].stage, ['c'])
      assert.deepEqual(completed[0].stage, ['a'])
      assert.deepEqual(completed[1].stage, ['b'])
      assert.deepEqual(completed[2].stage, ['c'])
    } finally {
      console.log = origLog
    }
  })

  it('runs all independent nodes in one stage', async () => {
    // DAG with no dependencies — all in one stage
    const dag: RunnableDag = {
      nodes: [node('x', [], 10), node('y', [], 10), node('z', [], 10)],
    }
    const { pool } = mockPool()

    const events: Record<string, unknown>[] = []
    const origLog = console.log
    console.log = (msg: string) => {
      try {
        events.push(JSON.parse(msg))
      } catch {
        /* skip */
      }
    }

    try {
      const scheduler = new ParallelScheduler(dag, pool, 4)
      await scheduler.run()

      // Single stage → exactly 2 events (started + completed)
      const started = events.filter((e) => e.event === 'DAG_STAGE_STARTED')
      assert.equal(started.length, 1)
      assert.deepEqual(
        [...(started[0].stage as string[])].sort(),
        ['x', 'y', 'z'],
      )
    } finally {
      console.log = origLog
    }
  })

  it('throws if maxParallelism < 1', () => {
    const dag: RunnableDag = { nodes: [] }
    const { pool } = mockPool()
    assert.throws(
      () => new ParallelScheduler(dag, pool, 0),
      /maxParallelism must be at least 1/,
    )
  })

  it('propagates node execution errors', async () => {
    const failing: RunnableNode = {
      id: 'fail',
      depends_on: [],
      async execute() {
        throw new Error('node exploded')
      },
    }
    const dag: RunnableDag = { nodes: [failing] }
    const { pool } = mockPool()
    const scheduler = new ParallelScheduler(dag, pool, 4)

    await assert.rejects(
      () => scheduler.run(),
      /node exploded/,
    )
  })

  it('aggregates results into a Map keyed by node_id', async () => {
    const n0 = node('alpha', [], 0, { value: 10 })
    const n1 = node('beta', ['alpha'], 0, { value: 20 })
    const n2 = node('gamma', [], 0, { value: 30 })
    const dag: RunnableDag = { nodes: [n0, n1, n2] }
    const { pool } = mockPool()
    const scheduler = new ParallelScheduler(dag, pool, 4)
    const results = await scheduler.run()

    assert.equal(results.size, 3)
    assert.deepEqual(results.get('alpha'), { value: 10 })
    assert.deepEqual(results.get('beta'), { value: 20 })
    assert.deepEqual(results.get('gamma'), { value: 30 })
  })

  it('executes correct number of tasks via worker pool', async () => {
    const dag: RunnableDag = {
      nodes: [
        node('a', []),
        node('b', ['a']),
        node('c', ['a']),
        node('d', ['b', 'c']),
      ],
    }
    const { pool, runCount } = mockPool()
    const scheduler = new ParallelScheduler(dag, pool, 4)
    await scheduler.run()
    assert.equal(runCount(), 4) // pool.run called once per node
  })
})
