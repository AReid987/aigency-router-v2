/**
 * Integration test: 4-leaf DAG distributes across 3+ workers with
 * capability-based routing, result aggregation, and failure recovery.
 */

import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  Distributor,
  AggregatedDispatchError,
  type PoolWorker,
  type DistributorWorkerPool,
} from './distributor.ts'
import { type RunnableDag } from './parallel_scheduler.ts'

// ── Scenario ───────────────────────────────────────────────────────────
//
// DAG: 1 root → 4 leaves
//
// Workers:
//   worker_a  cap: ["nlp-en"]
//   worker_b  cap: ["nlp-fr", "translation"]
//   worker_c  cap: ["nlp-es", "summarization"]
//   worker_d  cap: ["translation"]          (only used in failure-path test)
//
// Leaves require: ["nlp-en", "translation", "summarization", "nlp-en"]
//
// Expected routing (happy path):
//   leaf1 ("nlp-en")       → worker_a
//   leaf2 ("translation")  → worker_b
//   leaf3 ("summarization")→ worker_c
//   leaf4 ("nlp-en")       → worker_a  (or worker_a again via LRU)

describe('Distributor integration — 4-leaf DAG', () => {
  it('routes leaves to correct workers by capability and aggregates results', async () => {
    const workerA: PoolWorker = {
      id: 'worker_a',
      getCapabilities: () => ['nlp-en'],
      async run(task) {
        return task.execute()
      },
    }
    const workerB: PoolWorker = {
      id: 'worker_b',
      getCapabilities: () => ['nlp-fr', 'translation'],
      async run(task) {
        return task.execute()
      },
    }
    const workerC: PoolWorker = {
      id: 'worker_c',
      getCapabilities: () => ['nlp-es', 'summarization'],
      async run(task) {
        return task.execute()
      },
    }

    // Track which worker handled which task
    const assignments: Map<string, string> = new Map()

    const trackedA = wrapWorker(workerA, assignments)
    const trackedB = wrapWorker(workerB, assignments)
    const trackedC = wrapWorker(workerC, assignments)

    const pool: DistributorWorkerPool & { errorLog: string[] } = {
      getWorkers: () => [trackedA, trackedB, trackedC],
      markError: () => {},
      errorLog: [],
    }

    // DAG: root → leaf1, leaf2, leaf3, leaf4
    const dag: RunnableDag = {
      nodes: [
        {
          id: 'root',
          depends_on: [],
          async execute() {
            return 'root-done'
          },
        },
        {
          id: 'leaf1',
          depends_on: ['root'],
          required_capability: 'nlp-en',
          async execute() {
            return 'leaf1-result'
          },
        },
        {
          id: 'leaf2',
          depends_on: ['root'],
          required_capability: 'translation',
          async execute() {
            return 'leaf2-result'
          },
        },
        {
          id: 'leaf3',
          depends_on: ['root'],
          required_capability: 'summarization',
          async execute() {
            return 'leaf3-result'
          },
        },
        {
          id: 'leaf4',
          depends_on: ['root'],
          required_capability: 'nlp-en',
          async execute() {
            return 'leaf4-result'
          },
        },
      ],
    }

    const d = new Distributor(dag, pool, 3)
    const results = await d.aggregate()

    // (b) All 5 nodes (root + 4 leaves) execute
    assert.equal(results.size, 5)
    assert.equal(results.get('root'), 'root-done')
    assert.equal(results.get('leaf1'), 'leaf1-result')
    assert.equal(results.get('leaf2'), 'leaf2-result')
    assert.equal(results.get('leaf3'), 'leaf3-result')
    assert.equal(results.get('leaf4'), 'leaf4-result')

    // (a) Leaves route to correct workers based on capability
    assert.equal(assignments.get('leaf1'), 'worker_a')  // nlp-en → a
    assert.equal(assignments.get('leaf2'), 'worker_b')  // translation → b
    assert.equal(assignments.get('leaf3'), 'worker_c')  // summarization → c
    assert.equal(assignments.get('leaf4'), 'worker_a')  // nlp-en → a (LRU: a was used first, so it's least recent after use)

    // (c) All 5 results in a single Map
    assert.ok(results instanceof Map)
    assert.deepEqual(
      [...results.keys()].sort(),
      ['leaf1', 'leaf2', 'leaf3', 'leaf4', 'root'],
    )
  })

  it('recovers from worker failure via retry to alternative worker', async () => {
    // worker_b has 'translation' but fails on leaf2
    // worker_d also has 'translation' — should pick it up within retryCap
    const workerB: PoolWorker = {
      id: 'worker_b',
      getCapabilities: () => ['nlp-fr', 'translation'],
      async run(task) {
        if (task.id === 'leaf2') {
          throw new Error('worker_b temporary failure')
        }
        return task.execute()
      },
    }
    const workerD: PoolWorker = {
      id: 'worker_d',
      getCapabilities: () => ['translation'],
      async run(task) {
        return task.execute()
      },
    }
    const workerA: PoolWorker = {
      id: 'worker_a',
      getCapabilities: () => ['nlp-en'],
      async run(task) {
        return task.execute()
      },
    }

    const errors: string[] = []
    const pool: DistributorWorkerPool = {
      getWorkers: () => [workerA, workerB, workerD],
      markError: (wid: string) => { errors.push(wid) },
    }

    const dag: RunnableDag = {
      nodes: [
        {
          id: 'root',
          depends_on: [],
          async execute() { return 'ok' },
        },
        {
          id: 'leaf1',
          depends_on: ['root'],
          required_capability: 'nlp-en',
          async execute() { return 'l1' },
        },
        {
          id: 'leaf2',
          depends_on: ['root'],
          required_capability: 'translation',
          async execute() { return 'l2-recovered' },
        },
      ],
    }

    const d = new Distributor(dag, pool, 3)
    const results = await d.aggregate()

    assert.equal(results.get('leaf2'), 'l2-recovered')
    assert.ok(errors.includes('worker_b'), 'worker_b should have been marked as error')
    assert.equal(errors.length, 1)
  })

  it('throws AggregatedDispatchError when all translation workers fail', async () => {
    // All workers with 'translation' fail
    const workerB: PoolWorker = {
      id: 'worker_b',
      getCapabilities: () => ['nlp-fr', 'translation'],
      async run(task) {
        if (task.required_capability === 'translation') {
          throw new Error('translation unavailable')
        }
        return task.execute()
      },
    }
    const workerD: PoolWorker = {
      id: 'worker_d',
      getCapabilities: () => ['translation'],
      async run(task) {
        throw new Error('worker_d also unavailable')
      },
    }
    const workerA: PoolWorker = {
      id: 'worker_a',
      getCapabilities: () => ['nlp-en'],
      async run(task) {
        return task.execute()
      },
    }

    const pool: DistributorWorkerPool = {
      getWorkers: () => [workerA, workerB, workerD],
      markError: () => {},
    }

    const dag: RunnableDag = {
      nodes: [
        { id: 'root', depends_on: [], async execute() { return 'ok' } },
        {
          id: 'leaf2',
          depends_on: ['root'],
          required_capability: 'translation',
          async execute() { return 'will-fail' },
        },
      ],
    }

    const d = new Distributor(dag, pool, 2) // retryCap=2 → 3 total attempts

    await assert.rejects(
      () => d.aggregate(),
      (err: unknown) =>
        err instanceof AggregatedDispatchError &&
        err.nodeId === 'leaf2',
    )
  })
})

// ── Helpers ────────────────────────────────────────────────────────────

function wrapWorker(
  worker: PoolWorker,
  assignments: Map<string, string>,
): PoolWorker {
  return {
    ...worker,
    async run(task: any) {
      assignments.set(task.id, worker.id)
      return worker.run(task)
    },
  }
}
