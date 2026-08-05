/**
 * peer_reviewer.ts — Multi-worker peer review for Engram pipeline results.
 *
 * N peer reviewers independently score an aggregated result; consensus is
 * the median score. Below-threshold consensus triggers a re-route to a
 * worker with a capability not present in the failing set.
 *
 * Emits structured telemetry at each lifecycle point.
 */

import { logTelemetry, type TelemetryDeps } from '../../shared/telemetry.ts'

// ── Types ──────────────────────────────────────────────────────────────

/** A single result from the distributed/gated pipeline. */
export interface AggregatedResult {
  /** Map of node_id → final output value. */
  nodeResults: Map<string, unknown>
  /** Optional reference text used by earlier quality gates. */
  referenceText?: string
}

/** Verdict after peer review. */
export type ReviewVerdict = 'passed' | 'needs_reroute'

export interface ReviewOutcome {
  verdict: ReviewVerdict
  consensus: number
  scores: number[]
  recommended_worker?: string
}

/** A worker that can independently review a payload and score it. */
export interface PeerReviewWorker {
  readonly id: string
  /** Score the payload (0.0–1.0). Higher = better quality. */
  review(payload: unknown): Promise<{ score: number }>
  /** Capability set must be *distinct* from other reviewers to avoid correlated errors. */
  getCapabilities(): string[]
}

/** Pool from which the PeerReviewer selects reviewer workers. */
export interface PeerReviewWorkerPool {
  getWorkers(): PeerReviewWorker[]
}

// ── PeerReviewer ───────────────────────────────────────────────────────

export class PeerReviewer {
  constructor(
    private readonly workerPool: PeerReviewWorkerPool,
    private readonly consensusThreshold: number = 0.7,
    private readonly numReviewers: number = 3,
    private readonly telemetryDeps?: TelemetryDeps,
  ) {}

  /**
   * Run peer review on an aggregated pipeline result.
   *
   * Selects `numReviewers` workers with distinct capability sets,
   * has each score the result independently, computes consensus as
   * the median, and returns a verdict.
   */
  async review(aggregatedResult: AggregatedResult): Promise<ReviewOutcome> {
    const available = this.workerPool.getWorkers()

    if (available.length < this.numReviewers) {
      throw new PeerReviewError(
        `Not enough workers: need ${this.numReviewers}, have ${available.length}`,
      )
    }

    // Select reviewers with distinct capability sets
    const selected = this.selectReviewers(available)

    await this.emitTelemetry('PEER_REVIEW_STARTED', {
      reviewers: selected.map((w) => w.id),
      threshold: this.consensusThreshold,
    })

    // Run all reviews concurrently
    const reviewResults = await Promise.allSettled(
      selected.map((worker) => worker.review(aggregatedResult)),
    )

    const scores: number[] = []
    const failedReviewers: string[] = []

    for (let i = 0; i < selected.length; i++) {
      const result = reviewResults[i]
      if (result.status === 'fulfilled') {
        scores.push(result.value.score)
      } else {
        // Reviewer failed — score 0 and record the failed reviewer
        scores.push(0)
        failedReviewers.push(selected[i].id)
      }
    }

    // Consensus = median of scores
    const consensus = median(scores)

    if (consensus < this.consensusThreshold) {
      // Find a worker whose capabilities are NOT in the failing set.
      // The failing set = capabilities of reviewers that scored below threshold.
      const failingCapabilities = new Set<string>()
      for (let i = 0; i < selected.length; i++) {
        if (scores[i] < this.consensusThreshold) {
          for (const cap of selected[i].getCapabilities()) {
            failingCapabilities.add(cap)
          }
        }
      }

      // Find a worker in the pool (any, not just reviewers) whose capabilities
      // do NOT intersect with the failing set
      const recommended = available.find(
        (w) => !w.getCapabilities().some((cap) => failingCapabilities.has(cap)),
      )

      await this.emitTelemetry('PEER_REVIEW_FAILED_CONSENSUS', {
        consensus,
        threshold: this.consensusThreshold,
        scores,
        failedReviewers,
        recommendedWorker: recommended?.id,
      })

      return {
        verdict: 'needs_reroute',
        consensus,
        scores,
        recommended_worker: recommended?.id,
      }
    }

    await this.emitTelemetry('PEER_REVIEW_COMPLETED', {
      consensus,
      scores,
      reviewers: selected.map((w) => w.id),
    })

    return {
      verdict: 'passed',
      consensus,
      scores,
    }
  }

  /**
   * Select `numReviewers` workers with distinct capability sets.
   *
   * If a worker's capabilities are a subset of another already-selected
   * worker's capabilities, it is rejected (no correlated error margin).
   */
  private selectReviewers(available: PeerReviewWorker[]): PeerReviewWorker[] {
    const selected: PeerReviewWorker[] = []
    const usedCapabilities = new Set<string>()

    // Sort by most-capable first (richer capability set = more likely to be unique)
    const sorted = [...available].sort(
      (a, b) => b.getCapabilities().length - a.getCapabilities().length,
    )

    for (const worker of sorted) {
      if (selected.length >= this.numReviewers) break

      const caps = worker.getCapabilities()

      // Reject if all capabilities are already covered by selected workers
      if (caps.every((cap) => usedCapabilities.has(cap))) {
        continue
      }

      // Accept — add its capabilities to the used set
      selected.push(worker)
      for (const cap of caps) {
        usedCapabilities.add(cap)
      }
    }

    if (selected.length < this.numReviewers) {
      throw new PeerReviewError(
        `Cannot find ${this.numReviewers} workers with distinct capability sets (found ${selected.length})`,
      )
    }

    return selected
  }

  private async emitTelemetry(
    eventClass: 'PEER_REVIEW_STARTED' | 'PEER_REVIEW_COMPLETED' | 'PEER_REVIEW_FAILED_CONSENSUS',
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.telemetryDeps) return

    await logTelemetry(this.telemetryDeps, {
      eventClass,
      sourceWorker: 'peer_reviewer',
      payload,
    })
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Compute median of an array of numbers. Returns 0 for empty array. */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    // Odd length — middle element
    return sorted[mid]
  }
  // Even length — average of two middle elements
  return (sorted[mid - 1] + sorted[mid]) / 2
}

// ── Error ──────────────────────────────────────────────────────────────

export class PeerReviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PeerReviewError'
  }
}
