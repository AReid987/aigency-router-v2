/**
 * Parallel DAG Scheduler — executes a DAG in stages.
 *
 * Independent nodes within each stage run concurrently via a worker pool.
 * Stage boundaries emit telemetry via structured console.log.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface RunnableNode<T = unknown> {
  id: string
  depends_on: string[]
  execute: () => Promise<T>
  required_capability?: string
}

export interface RunnableDag<T = unknown> {
  nodes: RunnableNode<T>[]
}

export interface Task {
  id: string
  execute: () => Promise<unknown>
  required_capability?: string
}

export interface WorkerPool {
  run(task: Task): Promise<unknown>
  getCapabilities(): string[]
}

// ── Stage computation (exported for testing) ───────────────────────────

/**
 * Compute parallel execution stages using Kahn's algorithm.
 *
 * Each stage contains nodes that have no dependencies on other nodes in
 * the same or a later stage — i.e. all nodes in a stage can run in
 * parallel.  Stages are ordered: stage 0 must finish before stage 1 starts.
 *
 * Throws on unknown dependencies or cycles.
 */
export function computeStages<T>(nodes: RunnableNode<T>[]): RunnableNode<T>[][] {
  const nodeMap = new Map<string, RunnableNode<T>>()
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  // Sanity: no duplicate ids
  for (const node of nodes) {
    if (nodeMap.has(node.id)) {
      throw new Error(`Duplicate node id: "${node.id}"`)
    }
    nodeMap.set(node.id, node)
    inDegree.set(node.id, 0)
    adjacency.set(node.id, [])
  }

  if (nodes.length === 0) return []

  // Build adjacency list and compute in-degrees
  for (const node of nodes) {
    for (const dep of node.depends_on) {
      if (!nodeMap.has(dep)) {
        throw new Error(`Node "${node.id}" depends on unknown node "${dep}"`)
      }
      adjacency.get(dep)!.push(node.id)
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1)
    }
  }

  const stages: RunnableNode<T>[][] = []
  let currentLayer: string[] = []

  // Seed with nodes that have no dependencies
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      currentLayer.push(id)
    }
  }

  if (currentLayer.length === 0 && nodes.length > 0) {
    throw new Error('DAG has no root nodes — all nodes have dependencies or form a cycle')
  }

  while (currentLayer.length > 0) {
    const stageNodes = currentLayer.map((id) => nodeMap.get(id)!)
    stages.push(stageNodes)

    const nextLayer: string[] = []
    for (const id of currentLayer) {
      for (const neighbor of adjacency.get(id) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1
        inDegree.set(neighbor, newDegree)
        if (newDegree === 0) {
          nextLayer.push(neighbor)
        }
      }
    }
    currentLayer = nextLayer
  }

  // Validate all nodes were assigned to a stage
  const processed = stages.reduce((sum, s) => sum + s.length, 0)
  if (processed !== nodes.length) {
    throw new Error(
      `DAG contains a cycle: only ${processed}/${nodes.length} nodes were assigned to stages`,
    )
  }

  return stages
}

// ── Scheduler ──────────────────────────────────────────────────────────

export class ParallelScheduler<T = unknown> {
  constructor(
    private readonly dag: RunnableDag<T>,
    private readonly workerPool: WorkerPool,
    private readonly maxParallelism: number = 4,
  ) {
    if (maxParallelism < 1) {
      throw new Error('maxParallelism must be at least 1')
    }
  }

  /**
   * Execute the DAG in stages.
   *
   * Returns a Map of node_id → result for every node in the DAG.
   * Throws if any node execution fails.
   */
  async run(): Promise<Map<string, T>> {
    const stages = computeStages(this.dag.nodes)
    const results = new Map<string, T>()

    for (const stage of stages) {
      const stageIds = stage.map((n) => n.id)
      this.emitTelemetry('DAG_STAGE_STARTED', { stage: stageIds })

      const stageResults = await this.executeStage(stage)
      for (const [id, result] of stageResults) {
        results.set(id, result)
      }

      this.emitTelemetry('DAG_STAGE_COMPLETED', { stage: stageIds })
    }

    return results
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Execute all nodes in a single stage with parallelism capped at
   * `maxParallelism`.  Uses a sliding-window pattern: fill up to the cap,
   * race, fill again until all are done.
   */
  private async executeStage(stage: RunnableNode<T>[]): Promise<Map<string, T>> {
    if (stage.length === 0) return new Map()

    const results = new Map<string, T>()
    let nextIndex = 0
    const running = new Set<Promise<void>>()

    // Helpers
    const tryStartNext = (): void => {
      while (running.size < this.maxParallelism && nextIndex < stage.length) {
        const node = stage[nextIndex++]
        const p = this.workerPool
          .run({
            id: node.id,
            execute: () => node.execute(),
            required_capability: node.required_capability,
          })
          .then((result) => {
            results.set(node.id, result as T)
          })
          .finally(() => {
            running.delete(p)
          })
        running.add(p)
      }
    }

    // Fill the initial batch
    tryStartNext()

    // Race until completion
    while (running.size > 0) {
      await Promise.race(running)
      tryStartNext()
    }

    return results
  }

  private emitTelemetry(event: string, payload: Record<string, unknown>): void {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...payload,
      }),
    )
  }
}
