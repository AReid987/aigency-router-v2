import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ParallelScheduler,
  type RunnableNode,
  type RunnableDag,
  type WorkerPool,
} from './parallel_scheduler.ts'

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a mock worker pool that records execution slots. */
function trackedPool(delayMs: number): {
  pool: WorkerPool
  slots: Map<string, { start: number; end: number }>
} {
  const slots = new Map<string, { start: number; end: number }>()
  return {
    slots,
    pool: {
      async run(task) {
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
    },
  }
}

function node(id: string, depends_on: string[], delayMs: number = 0): RunnableNode {
  return {
    id,
    depends_on,
    async execute() {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return `result-${id}`
    },
  }
}

// ── Integration tests ──────────────────────────────────────────────────

describe('ParallelScheduler integration', () => {
  it('executes a 5-node fanout DAG correctly', async () => {
    // n1 → {n2, n3, n4} → n5
    // Each task takes 100ms
    // Serial budget: 5 * 100 = 500ms
    // With full parallelism: 100ms (n1) + 100ms (n2/n3/n4) + 100ms (n5) = ~300ms
    const dag: RunnableDag = {
      nodes: [
        node('n1', [], 100),
        node('n2', ['n1'], 100),
        node('n3', ['n1'], 100),
        node('n4', ['n1'], 100),
        node('n5', ['n2', 'n3', 'n4'], 100),
      ],
    }

    const { pool, slots } = trackedPool(0) // delay handled by nodes
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
      const scheduler = new ParallelScheduler(dag, pool, 10) // high cap to allow full parallelism
      const start = Date.now()
      const results = await scheduler.run()
      const elapsed = Date.now() - start

      // (a) Topological order verification: n1 first, then {n2,n3,n4}, then n5
      const startedEvents = events.filter((e) => e.event === 'DAG_STAGE_STARTED')
      assert.equal(startedEvents.length, 3)
      assert.deepEqual(startedEvents[0].stage, ['n1'])
      assert.deepEqual((startedEvents[1].stage as string[]).sort(), ['n2', 'n3', 'n4'])
      assert.deepEqual(startedEvents[2].stage, ['n5'])

      // (b) Wall-clock substantially less than serial (500ms)
      // Serial would be 5*100=500ms. Parallel with 3 stages = ~300ms.
      assert.ok(
        elapsed < 450,
        `Expected <450ms (serial would be 500ms), got ${elapsed}ms`,
      )

      // (c) Verify n2, n3, n4 ran concurrently (their time windows overlap)
      const n2Slot = slots.get('n2')!
      const n3Slot = slots.get('n3')!
      const n4Slot = slots.get('n4')!
      assert.ok(n2Slot, 'n2 should have a recorded slot')
      assert.ok(n3Slot, 'n3 should have a recorded slot')
      assert.ok(n4Slot, 'n4 should have a recorded slot')

      // All three should overlap with each other
      const n23overlap =
        n2Slot.start < n3Slot.end && n3Slot.start < n2Slot.end
      const n24overlap =
        n2Slot.start < n4Slot.end && n4Slot.start < n2Slot.end
      const n34overlap =
        n3Slot.start < n4Slot.end && n4Slot.start < n3Slot.end
      assert.ok(n23overlap, 'n2 and n3 should overlap')
      assert.ok(n24overlap, 'n2 and n4 should overlap')
      assert.ok(n34overlap, 'n3 and n4 should overlap')

      // n1 should finish before n2 starts
      const n1Slot = slots.get('n1')!
      assert.ok(n1Slot.end <= n2Slot.start, 'n1 should finish before n2 starts')

      // n5 should start after n2, n3, n4 all finish
      const n5Slot = slots.get('n5')!
      const latestMid = Math.max(n2Slot.end, n3Slot.end, n4Slot.end)
      assert.ok(
        n5Slot.start >= latestMid,
        'n5 should start after n2,n3,n4 all finish',
      )

      // (d) Results aggregated correctly
      assert.equal(results.size, 5)
      assert.equal(results.get('n1'), 'result-n1')
      assert.equal(results.get('n2'), 'result-n2')
      assert.equal(results.get('n3'), 'result-n3')
      assert.equal(results.get('n4'), 'result-n4')
      assert.equal(results.get('n5'), 'result-n5')

      // (e) Telemetry events with correct payloads
      const completedEvents = events.filter(
        (e) => e.event === 'DAG_STAGE_COMPLETED',
      )
      assert.equal(completedEvents.length, 3)
      assert.deepEqual(completedEvents[0].stage, ['n1'])
      assert.deepEqual(
        (completedEvents[1].stage as string[]).sort(),
        ['n2', 'n3', 'n4'],
      )
      assert.deepEqual(completedEvents[2].stage, ['n5'])
    } finally {
      console.log = origLog
    }
  })

  it('respects max_parallelism cap with many leaf nodes', async () => {
    // 8 independent leaf nodes all depending on one root
    // Root: n_root (50ms delay)
    // Leaves: n0..n7 each with 50ms delay
    // Cap = 3 → rounds: 1 (root) + ceil(8/3) = 1+3 = 4 rounds × 50ms = ~200ms
    // Without cap: 1 (root) + 1 (leaves in parallel) = 2 rounds × 50ms = ~100ms
    const leaves: RunnableNode[] = []
    for (let i = 0; i < 8; i++) {
      leaves.push(node(`n${i}`, ['root'], 50))
    }
    const dag: RunnableDag = {
      nodes: [node('root', [], 50), ...leaves],
    }

    const { pool } = trackedPool(0)
    const scheduler = new ParallelScheduler(dag, pool, 3)
    const start = Date.now()
    const results = await scheduler.run()
    const elapsed = Date.now() - start

    // With cap=3: 1 (root) + ceil(8/3)=3 → 4 rounds × 50ms = ~200ms
    // Without cap: 2 rounds × 50ms = ~100ms
    // Elapsed should be > 150ms (at least 3 rounds of 50ms)
    // And < 450ms (nowhere near serial: 9*50=450ms)
    assert.ok(elapsed > 120, `Expected >120ms (capped parallelism), got ${elapsed}ms`)
    assert.ok(elapsed < 400, `Expected <400ms, got ${elapsed}ms`)

    // All 9 results present (root + 8 leaves)
    assert.equal(results.size, 9)
    assert.equal(results.get('root'), 'result-root')
    for (let i = 0; i < 8; i++) {
      assert.equal(results.get(`n${i}`), `result-n${i}`)
    }
  })

  it('handles DAG with no dependencies — full parallel', async () => {
    // 5 independent nodes, each with 50ms delay
    const nodes: RunnableNode[] = []
    for (let i = 0; i < 5; i++) {
      nodes.push(node(`n${i}`, [], 50))
    }
    const dag: RunnableDag = { nodes }

    const { pool } = trackedPool(0)
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
      const scheduler = new ParallelScheduler(dag, pool, 10)
      const start = Date.now()
      const results = await scheduler.run()
      const elapsed = Date.now() - start

      // Single stage — exactly 2 telemetry events
      const startedEvents = events.filter((e) => e.event === 'DAG_STAGE_STARTED')
      assert.equal(startedEvents.length, 1)
      assert.equal(
        (startedEvents[0].stage as string[]).length,
        5,
        'all 5 nodes in one stage',
      )

      // ~50ms vs serial 250ms
      assert.ok(elapsed < 200, `Expected <200ms for full parallel, got ${elapsed}ms`)

      assert.equal(results.size, 5)
    } finally {
      console.log = origLog
    }
  })

  it('handles deep dependency chain correctly', async () => {
    // n0 → n1 → n2 → n3 → n4 (5-level chain)
    const nodes: RunnableNode[] = []
    for (let i = 0; i < 5; i++) {
      nodes.push(node(`n${i}`, i > 0 ? [`n${i - 1}`] : [], 50))
    }
    const dag: RunnableDag = { nodes }

    const { pool } = trackedPool(0)
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
      const scheduler = new ParallelScheduler(dag, pool, 10)
      const start = Date.now()
      const results = await scheduler.run()
      const elapsed = Date.now() - start

      // 5 stages × 50ms = ~250ms
      assert.ok(elapsed > 180, `Expected >180ms (5 sequential stages), got ${elapsed}ms`)
      assert.ok(elapsed < 450, `Expected <450ms, got ${elapsed}ms`)

      // 5 stages
      const startedEvents = events.filter((e) => e.event === 'DAG_STAGE_STARTED')
      assert.equal(startedEvents.length, 5)
      for (let i = 0; i < 5; i++) {
        assert.deepEqual(startedEvents[i].stage, [`n${i}`])
      }

      assert.equal(results.size, 5)
      assert.equal(results.get('n4'), 'result-n4')
    } finally {
      console.log = origLog
    }
  })

  it('satisfies all 5 integration requirements: (a)-(e)', async () => {
    // Comprehensive test mirroring the spec's requirements:
    // 5-node DAG: node1 → {node2, node3, node4} → node5
    // Each mock task takes 100ms
    const dag: RunnableDag = {
      nodes: [
        node('node1', [], 100),
        node('node2', ['node1'], 100),
        node('node3', ['node1'], 100),
        node('node4', ['node1'], 100),
        node('node5', ['node2', 'node3', 'node4'], 100),
      ],
    }

    const { pool, slots } = trackedPool(0)
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
      const start = Date.now()
      const results = await scheduler.run()
      const elapsed = Date.now() - start

      // (a) Topological order: node1 first, then {node2,node3,node4}, then node5
      const stageOrder = events
        .filter((e) => e.event === 'DAG_STAGE_STARTED')
        .map((e) => (e.stage as string[]).sort())
      assert.equal(stageOrder.length, 3)
      assert.deepEqual(stageOrder[0], ['node1'])
      assert.deepEqual(stageOrder[1].sort(), ['node2', 'node3', 'node4'])
      assert.deepEqual(stageOrder[2], ['node5'])

      // (b) Wall-clock < serial (target: < 500ms; serial would be 500ms)
      // Parallel with 3 stages x 100ms = ~300ms
      assert.ok(elapsed < 480, `(b) Expected <480ms, got ${elapsed}ms`)

      // (c) max_parallelism cap — test with 8 leaves + cap 3 done in separate test above

      // (d) Results aggregated correctly into Map keyed by node_id
      assert.equal(results.size, 5)
      assert.equal(results.get('node1'), 'result-node1')
      assert.equal(results.get('node2'), 'result-node2')
      assert.equal(results.get('node3'), 'result-node3')
      assert.equal(results.get('node4'), 'result-node4')
      assert.equal(results.get('node5'), 'result-node5')

      // (e) Telemetry events
      const completedEvents = events.filter(
        (e) => e.event === 'DAG_STAGE_COMPLETED',
      )
      assert.equal(completedEvents.length, 3)
      assert.deepEqual(completedEvents[0].stage, ['node1'])
      assert.deepEqual(
        (completedEvents[1].stage as string[]).sort(),
        ['node2', 'node3', 'node4'],
      )
      assert.deepEqual(completedEvents[2].stage, ['node5'])
    } finally {
      console.log = origLog
    }
  })
})
