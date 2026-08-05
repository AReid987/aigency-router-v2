/**
 * Distributor — routes DAG sub-tasks across a worker pool using
 * capability-based matching with LRU tie-breaking and automatic retry.
 *
 * Streams results via AsyncGenerator as workers complete, then
 * provides a final aggregate() for the full result Map.
 */

import { computeStages, type RunnableDag, type RunnableNode, type Task } from './parallel_scheduler.ts'
import { logTelemetry, type TelemetryDeps } from '../../shared/telemetry.ts'

// ── Types ──────────────────────────────────────────────────────────────

/** A single worker in the pool, each with its own capabilities. */
export interface PoolWorker {
  readonly id: string
  run(task: Task): Promise<unknown>
  getCapabilities(): string[]
}

/** A pool of workers the distributor can route tasks to. */
export interface DistributorWorkerPool {
  getWorkers(): PoolWorker[]
  markError(workerId: string): void
}

/** Single yielded result from the streaming generator. */
export interface NodeResult<T = unknown> {
  node_id: string
  result: T
}

/**
 * Thrown when a node exhausts all retry attempts.
 */
export class AggregatedDispatchError extends Error {
  constructor(
    message: string,
    public readonly nodeId: string,
    public readonly attempts: number,
  ) {
    super(message)
    this.name = 'AggregatedDispatchError'
  }
}

/** Comparator for LRU sorting — least recently used first. */
function lruComparator(timestamps: Map<string, number>): (a: { id: string }, b: { id: string }) => number {
  return (a, b) => {
    const aTime = timestamps.get(a.id) ?? 0
    const bTime = timestamps.get(b.id) ?? 0
    return aTime - bTime
  }
}

// ── Distributor ────────────────────────────────────────────────────────

export class Distributor<T = unknown> {
  /** Per-worker last-used timestamp for LRU tracking (0 = never used). */
  private workerTimestamps: Map<string, number> = new Map()

  constructor(
    private readonly dag: RunnableDag<T>,
    private readonly pool: DistributorWorkerPool,
    private readonly retryCap: number = 3,
    private readonly telemetryDeps?: TelemetryDeps,
  ) {
    for (const worker of pool.getWorkers()) {
      this.workerTimestamps.set(worker.id, 0)
    }
  }

  /**
   * Stream results as sub-tasks complete across all DAG stages.
   *
   * Stages are executed sequentially (respecting the DAG), but nodes
   * within a stage run concurrently.  Results are yielded in completion
   * order, which may differ from start order.
   */
  async *distribute(): AsyncGenerator<NodeResult<T>> {
    const stages = computeStages(this.dag.nodes)

    for (const stage of stages) {
      // Start every node in this stage concurrently
      const promises = stage.map((node) => this.executeNodeWithRetry(node))

      // Yield results as they complete (out-of-order is explicitly OK)
      const entries: Promise<{ idx: number; result: NodeResult<T> }>[] = promises.map((p, idx) =>
        p.then((r) => ({ idx, result: r })),
      )

      while (entries.length > 0) {
        const winner = await Promise.race(entries)
        yield winner.result
        // Remove the winning entry by swapping with last
        const lastIdx = entries.length - 1
        if (winner.idx !== lastIdx) {
          entries[winner.idx] = entries[lastIdx]
          // Fix the index stored inside the promise by re-wrapping
          const fixed = entries[winner.idx].then((r) => ({ ...r, idx: winner.idx }))
          entries[winner.idx] = fixed
        }
        entries.pop()
      }
    }
  }

  /**
   * Execute all DAG nodes and return a Map of node_id → result.
   *
   * A convenience wrapper around distribute().
   */
  async aggregate(): Promise<Map<string, T>> {
    const results = new Map<string, T>()
    for await (const { node_id, result } of this.distribute()) {
      results.set(node_id, result)
    }
    return results
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Execute a single node with retry logic.
   *
   * Selects the best-fit worker, runs the task, and retries with the
   * next-best worker on failure (up to retryCap attempts).
   */
  private async executeNodeWithRetry(node: RunnableNode<T>): Promise<NodeResult<T>> {
    const nodeId = node.id
    const tried = new Set<string>()
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.retryCap; attempt++) {
      const worker = this.selectWorker(node.required_capability, tried)

      // No worker available (all tried or none exist)
      if (!worker) {
        if (tried.size === 0) {
          throw new AggregatedDispatchError(
            `No worker available for node "${nodeId}" (required: ${node.required_capability ?? 'none'})`,
            nodeId,
            0,
          )
        }
        break
      }

      tried.add(worker.id)
      this.workerTimestamps.set(worker.id, Date.now())

      await this.emitTelemetry('TASK_DISPATCHED', {
        node_id: nodeId,
        worker_id: worker.id,
        attempt,
      })

      try {
        const result = await worker.run({
          id: nodeId,
          execute: () => node.execute(),
          required_capability: node.required_capability,
        })

        await this.emitTelemetry('TASK_AGGREGATED', {
          node_id: nodeId,
          worker_id: worker.id,
        })

        return { node_id: nodeId, result: result as T }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        this.pool.markError(worker.id)
        // Fall through to next attempt
      }
    }

    throw new AggregatedDispatchError(
      lastError
        ? `Node "${nodeId}" failed after ${tried.size} attempt(s): ${lastError.message}`
        : `Node "${nodeId}" exhausted retries after ${tried.size} attempt(s)`,
      nodeId,
      tried.size,
    )
  }

  /**
   * Select the best-fit worker for a required capability.
   *
   * Priority:
   *   1. Workers whose capabilities include `requiredCapability`
   *   2. LRU (least recently used) to break ties
   *   3. Any worker as fallback when no capability match (only when
   *      the node does NOT specify a required_capability — for nodes
   *      that require a specific capability we must not fall back)
   */
  private selectWorker(requiredCapability?: string, exclude?: Set<string>): PoolWorker | undefined {
    const workers = this.pool.getWorkers().filter((w) => !exclude?.has(w.id))
    if (workers.length === 0) return undefined

    // (1) Capability match — required when the node declares a capability
    if (requiredCapability) {
      const matches = workers.filter((w) => w.getCapabilities().includes(requiredCapability))
      // Only return a matching worker — never fall back for required-capability nodes
      if (matches.length === 0) return undefined
      matches.sort(lruComparator(this.workerTimestamps))
      return matches[0]
    }

    // (2) No required capability — LRU tie-breaking, any worker
    const sorted = [...workers].sort(lruComparator(this.workerTimestamps))
    return sorted[0]
  }

  private async emitTelemetry(eventClass: 'TASK_DISPATCHED' | 'TASK_AGGREGATED', payload: Record<string, unknown>): Promise<void> {
    if (!this.telemetryDeps) return

    await logTelemetry(this.telemetryDeps, {
      eventClass,
      sourceWorker: 'distributor',
      payload,
    })
  }
}
