/**
 * peer_reviewer.test.ts — Tests for PeerReviewer consensus + re-route behavior.
 */

import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PeerReviewer,
  median,
  type AggregatedResult,
  type PeerReviewWorker,
  type PeerReviewWorkerPool,
} from './peer_reviewer.ts'
import { type TelemetryDeps } from '../../shared/telemetry.ts'

// ── Helpers ────────────────────────────────────────────────────────────

function makeWorker(id: string, capabilities: string[]): PeerReviewWorker {
  return {
    id,
    getCapabilities: () => capabilities,
    async review() {
      return { score: 0.9 }
    },
  }
}

/** Worker that returns a fixed score. */
function scoringWorker(id: string, capabilities: string[], score: number): PeerReviewWorker {
  return {
    id,
    getCapabilities: () => capabilities,
    async review() {
      return { score }
    },
  }
}

/** Worker that fails (throws) during review. */
function failingWorker(id: string, capabilities: string[]): PeerReviewWorker {
  return {
    id,
    getCapabilities: () => capabilities,
    async review() {
      throw new Error(`${id} failed during review`)
    },
  }
}

function makePool(workers: PeerReviewWorker[]): PeerReviewWorkerPool {
  return {
    getWorkers: () => workers,
  }
}

function aggregatedResult(overrides?: Partial<AggregatedResult>): AggregatedResult {
  return {
    nodeResults: new Map([
      ['root', 'root-output'],
      ['leaf1', 'leaf1-output'],
    ]),
    ...overrides,
  }
}

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

// ── Median ─────────────────────────────────────────────────────────────

describe('median', () => {
  it('returns the middle element for odd-length arrays', () => {
    assert.equal(median([0.9, 0.8, 0.1, 0.7, 0.6]), 0.7)
  })

  it('returns average of two middle elements for even-length arrays', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5)
  })

  it('returns 0 for empty array', () => {
    assert.equal(median([]), 0)
  })

  it('handles single-element array', () => {
    assert.equal(median([0.5]), 0.5)
  })

  it('returns median of unsorted input', () => {
    assert.equal(median([0.1, 0.9, 0.5]), 0.5)
  })
})

// ── PeerReviewer: consensus as median ──────────────────────────────────

describe('PeerReviewer — consensus', () => {
  it('computes consensus as median (not mean) for 5 reviewers', async () => {
    // Scores [0.9, 0.8, 0.1, 0.7, 0.6]
    // Median = 0.7, Mean = 0.62
    const workers = [
      scoringWorker('w1', ['nlp-en'], 0.9),
      scoringWorker('w2', ['nlp-fr'], 0.8),
      scoringWorker('w3', ['vision'], 0.1),
      scoringWorker('w4', ['summarization'], 0.7),
      scoringWorker('w5', ['translation'], 0.6),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 5)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.consensus, 0.7) // median, not mean
    assert.deepEqual(outcome.scores.sort(), [0.1, 0.6, 0.7, 0.8, 0.9])
  })

  it('returns passed when consensus meets threshold', async () => {
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-fr']),
      makeWorker('w3', ['vision']),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.7, 3)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.verdict, 'passed')
    assert.equal(outcome.consensus, 0.9)
  })

  it('returns needs_reroute when consensus is below threshold', async () => {
    // w4 in pool but NOT a reviewer (not needed to reach 3). all caps failing.
    // w4 has 'translation' — NOT in failing set → recommended_worker defined.
    const workers = [
      scoringWorker('w1', ['nlp-en'], 0.2),
      scoringWorker('w2', ['nlp-fr'], 0.4),
      scoringWorker('w3', ['vision'], 0.2),
      scoringWorker('w4', ['translation'], 0.9),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 3)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.verdict, 'needs_reroute')
    assert.equal(outcome.consensus, 0.2)
    assert.ok(outcome.recommended_worker !== undefined)
  })
})

// ── num_reviewers ──────────────────────────────────────────────────────

describe('PeerReviewer — num_reviewers', () => {
  it('uses default of 3 reviewers', async () => {
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-fr']),
      makeWorker('w3', ['vision']),
      makeWorker('w4', ['summarization']),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5) // default num_reviewers=3
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.scores.length, 3)
    assert.equal(outcome.verdict, 'passed')
  })

  it('respects configurable num_reviewers', async () => {
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-fr']),
      makeWorker('w3', ['vision']),
      makeWorker('w4', ['summarization']),
      makeWorker('w5', ['translation']),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 5)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.scores.length, 5)
  })
})

// ── Distinct capability sets ──────────────────────────────────────────

describe('PeerReviewer — distinct capability sets', () => {
  it('rejects reviewers with duplicate capabilities', async () => {
    // w1 and w2 have identical capability sets
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-en']), // duplicate of w1
      makeWorker('w3', ['nlp-fr']),
      makeWorker('w4', ['vision']),
    ]
    const pool = makePool(workers)
    // With num_reviewers=3, we need 3 distinct capability sets
    // w1 and w2 share 'nlp-en', so only w1, w3, w4 are eligible
    const reviewer = new PeerReviewer(pool, 0.5, 3)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.scores.length, 3)
    assert.equal(outcome.verdict, 'passed')
  })

  it('throws when not enough workers with distinct capabilities', async () => {
    // 3 workers, but w2 and w3 share capabilities with each other
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-en']), // duplicate
      makeWorker('w3', ['nlp-en']), // also duplicate
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 3)

    await assert.rejects(
      () => reviewer.review(aggregatedResult()),
      (err: unknown) =>
        err instanceof Error &&
        err.name === 'PeerReviewError' &&
        err.message.includes('distinct capability'),
    )
  })

  it('throws when pool has fewer workers than num_reviewers', async () => {
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-fr']),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 3)

    await assert.rejects(
      () => reviewer.review(aggregatedResult()),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Not enough workers'),
    )
  })
})

// ── recommended_worker ─────────────────────────────────────────────────

describe('PeerReviewer — recommended_worker', () => {
  it('recommends a worker not in the failing set on reroute', async () => {
    // 5 workers. selectReviewers picks 3 with distinct caps: w1, w3, w4
    // (w2 has 'nlp-en' dup of w1; w5 not needed).
    // w1 scores low, w3 scores low → failing caps = {'nlp-en', 'vision'}
    // w4 scored high → 'translation' NOT in failing set.
    // recommended worker = first whose cap NOT in {'nlp-en', 'vision'}
    const workers = [
      scoringWorker('w1', ['nlp-en'], 0.2),
      scoringWorker('w2', ['nlp-en'], 0.9),
      scoringWorker('w3', ['vision'], 0.3),
      scoringWorker('w4', ['translation'], 0.9),
      scoringWorker('w5', ['audio'], 0.9),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 3)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.verdict, 'needs_reroute')
    assert.ok(outcome.recommended_worker !== undefined, 'Should recommend a worker')
    const recommendedWorker = workers.find((w) => w.id === outcome.recommended_worker)
    assert.ok(recommendedWorker, 'Recommended worker should exist in pool')
    const failingCaps = ['nlp-en', 'vision']
    const hasFailingCap = recommendedWorker!.getCapabilities().some((c) => failingCaps.includes(c))
    assert.equal(hasFailingCap, false, 'Recommended worker should not have failing capability')
  })

  it('returns recommended_worker as undefined when all workers are in failing set', async () => {
    const workers = [
      scoringWorker('w1', ['nlp-en'], 0.1),
      scoringWorker('w2', ['nlp-fr'], 0.2),
      scoringWorker('w3', ['vision'], 0.3),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 3)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.verdict, 'needs_reroute')
    // All reviewers scored below threshold, so all their capabilities are failing
    // No worker in the pool has a capability outside the failing set
    assert.equal(outcome.recommended_worker, undefined)
  })
})

// ── Telemetry ──────────────────────────────────────────────────────────

describe('PeerReviewer — telemetry', () => {
  it('emits PEER_REVIEW_STARTED on begin', async () => {
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-fr']),
      makeWorker('w3', ['vision']),
    ]
    const pool = makePool(workers)
    const { deps, events } = mockTelemetryDeps()
    const reviewer = new PeerReviewer(pool, 0.5, 3, deps)

    await reviewer.review(aggregatedResult())

    const started = events.find(
      (e: any) => e.eventClass === 'PEER_REVIEW_STARTED',
    ) as any
    assert.ok(started, 'Should emit PEER_REVIEW_STARTED')
    assert.ok(Array.isArray(started.payload.reviewers))
    assert.equal(started.payload.reviewers.length, 3)
    assert.equal(started.payload.threshold, 0.5)
  })

  it('emits PEER_REVIEW_COMPLETED on pass', async () => {
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-fr']),
      makeWorker('w3', ['vision']),
    ]
    const pool = makePool(workers)
    const { deps, events } = mockTelemetryDeps()
    const reviewer = new PeerReviewer(pool, 0.5, 3, deps)

    await reviewer.review(aggregatedResult())

    const completed = events.find(
      (e: any) => e.eventClass === 'PEER_REVIEW_COMPLETED',
    ) as any
    assert.ok(completed, 'Should emit PEER_REVIEW_COMPLETED')
    assert.ok(typeof completed.payload.consensus === 'number')
    assert.ok(Array.isArray(completed.payload.scores))
    assert.equal(completed.payload.scores.length, 3)
  })

  it('emits PEER_REVIEW_FAILED_CONSENSUS on below-threshold', async () => {
    const workers = [
      scoringWorker('w1', ['nlp-en'], 0.2),
      scoringWorker('w2', ['nlp-fr'], 0.3),
      scoringWorker('w3', ['vision'], 0.4),
    ]
    const pool = makePool(workers)
    const { deps, events } = mockTelemetryDeps()
    const reviewer = new PeerReviewer(pool, 0.5, 3, deps)

    await reviewer.review(aggregatedResult())

    const failed = events.find(
      (e: any) => e.eventClass === 'PEER_REVIEW_FAILED_CONSENSUS',
    ) as any
    assert.ok(failed, 'Should emit PEER_REVIEW_FAILED_CONSENSUS')
    assert.equal(failed.payload.consensus, 0.3)
    assert.equal(failed.payload.threshold, 0.5)
  })

  it('emits all 3 events in correct order', async () => {
    const workers = [
      scoringWorker('w1', ['nlp-en'], 0.2),
      scoringWorker('w2', ['nlp-fr'], 0.3),
      scoringWorker('w3', ['vision'], 0.4),
    ]
    const pool = makePool(workers)
    const { deps, events } = mockTelemetryDeps()
    const reviewer = new PeerReviewer(pool, 0.5, 3, deps)

    await reviewer.review(aggregatedResult())

    const eventClasses = events.map((e: any) => e.eventClass)
    assert.equal(eventClasses.length, 2) // STARTED + FAILED (no COMPLETED)
    assert.ok(eventClasses.includes('PEER_REVIEW_STARTED'))
    assert.ok(eventClasses.includes('PEER_REVIEW_FAILED_CONSENSUS'))
    assert.equal(eventClasses.includes('PEER_REVIEW_COMPLETED'), false)
  })

  it('emits all 3 events on passing review', async () => {
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-fr']),
      makeWorker('w3', ['vision']),
    ]
    const pool = makePool(workers)
    const { deps, events } = mockTelemetryDeps()
    const reviewer = new PeerReviewer(pool, 0.5, 3, deps)

    await reviewer.review(aggregatedResult())

    const eventClasses = events.map((e: any) => e.eventClass)
    assert.equal(eventClasses.length, 2) // STARTED + COMPLETED (no FAILED)
    assert.ok(eventClasses.includes('PEER_REVIEW_STARTED'))
    assert.ok(eventClasses.includes('PEER_REVIEW_COMPLETED'))
    assert.equal(eventClasses.includes('PEER_REVIEW_FAILED_CONSENSUS'), false)
  })
})

// ── Edge case: all reviewers fail ──────────────────────────────────────

describe('PeerReviewer — all reviewers fail', () => {
  it('returns needs_reroute with consensus=0 when all reviewers throw', async () => {
    const workers = [
      failingWorker('w1', ['nlp-en']),
      failingWorker('w2', ['nlp-fr']),
      failingWorker('w3', ['vision']),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 3)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.verdict, 'needs_reroute')
    assert.equal(outcome.consensus, 0)
    assert.deepEqual(outcome.scores, [0, 0, 0])
  })

  it('returns needs_reroute with partial failure and low consensus', async () => {
    // 2 out of 3 fail; the one that succeeds scores 0.4 — below 0.5 threshold
    const workers = [
      failingWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-fr']),
      scoringWorker('w3', ['vision'], 0.4),
    ]
    const pool = makePool(workers)
    // Override w2's score to be 0.4 as well
    // Actually let's make w2 return 0.6 — median of [0, 0.6, 0.4] = 0.4
    const customWorkers = [
      failingWorker('w1', ['nlp-en']),
      scoringWorker('w2', ['nlp-fr'], 0.6),
      scoringWorker('w3', ['vision'], 0.4),
    ]
    const customPool = makePool(customWorkers)
    const reviewer = new PeerReviewer(customPool, 0.5, 3)
    const outcome = await reviewer.review(aggregatedResult())

    // Median of [0, 0.4, 0.6] = 0.4
    assert.equal(outcome.consensus, 0.4)
    assert.equal(outcome.verdict, 'needs_reroute')
  })
})

// ── ReviewOutcome type shape ───────────────────────────────────────────

describe('ReviewOutcome — type shape', () => {
  it('has correct structure for passed verdict', async () => {
    const workers = [
      makeWorker('w1', ['nlp-en']),
      makeWorker('w2', ['nlp-fr']),
      makeWorker('w3', ['vision']),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 3)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.verdict, 'passed')
    assert.ok(typeof outcome.consensus === 'number')
    assert.ok(Array.isArray(outcome.scores))
    assert.equal(outcome.scores.length, 3)
    assert.equal(outcome.recommended_worker, undefined)
  })

  it('has correct structure for needs_reroute verdict', async () => {
    const workers = [
      scoringWorker('w1', ['nlp-en'], 0.2),
      scoringWorker('w2', ['nlp-fr'], 0.3),
      scoringWorker('w3', ['vision'], 0.1),
      scoringWorker('w4', ['translation'], 0.9),
    ]
    const pool = makePool(workers)
    const reviewer = new PeerReviewer(pool, 0.5, 3)
    const outcome = await reviewer.review(aggregatedResult())

    assert.equal(outcome.verdict, 'needs_reroute')
    assert.ok(typeof outcome.consensus === 'number')
    assert.ok(Array.isArray(outcome.scores))
    assert.equal(outcome.scores.length, 3)
    assert.equal(outcome.recommended_worker, 'w4')
  })
})
