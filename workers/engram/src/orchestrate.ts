/**
 * orchestrate.ts — Engram pipeline orchestrator.
 *
 * Composes M006 (DAG planner) + M011 primitives (distributor pattern,
 * quality gates, parallel execution, peer review) into a single
 * engram::orchestrate worker function.
 *
 * The orchestrator:
 *   1. Decomposes a request into a DAG via SimpleDAGPlanner
 *   2. Executes DAG stages sequentially with parallel node execution
 *      within each stage (distribute pattern via computeStages)
 *   3. Applies quality gates to each node result between stages
 *   4. Retries failed nodes with re-routed workers on gate failure
 *   5. Aggregates all stage results into a single prompt context
 *   6. Runs peer review on the aggregated output
 *   7. Returns an OrchestrateResult envelope
 */

import { computeStages, type RunnableNode, type RunnableDag } from '../../gateway/src/parallel_scheduler.ts'
import { type QualityGateSpec, evaluate as evaluateGate } from './quality_gate.ts'
import { PeerReviewer, type AggregatedResult, type ReviewOutcome } from '../../gateway/src/peer_reviewer.ts'
import { SimpleDAGPlanner, type PlannerInput } from '../../gateway/src/dag-planner.ts'

// ── Types ──────────────────────────────────────────────────────────────

export interface Message {
  role: string
  content: string
}

export interface OrchestrateInput {
  messages: Message[]
  model: string
  requestId: string
}

export interface OrchestrateMetadata {
  stagesCompleted: number
  peerReviewConsensus: number
  gatesPassed: number
  gatesFailed: number
  retriesUsed: number
  nodeCount: number
  dagId: string
  stageDetails: StageDetail[]
  reviewOutcome?: ReviewOutcome
}

export interface StageDetail {
  stageIndex: number
  nodeIds: string[]
  gatesPassed: number
  gatesFailed: number
  retriesUsed: number
}

export interface OrchestrateResult {
  content: string
  finishReason: 'stop'
  metadata: OrchestrateMetadata
}

/** Gate spec overrides keyed by node id. */
export interface OrchestrateConfig {
  retryCap?: number
  consensusThreshold?: number
  numReviewers?: number
  gateSpecs?: Record<string, QualityGateSpec>
}

/**
 * Dependencies injected into the orchestrator.
 * In production, `trigger` calls iii.trigger for node execution.
 * For tests, provide mock implementations.
 */
export interface OrchestrateDeps {
  /** Execute a node by calling its function_id with payload. Returns the result value. */
  trigger: (fnId: string, payload: Record<string, unknown>) => Promise<unknown>
  /** Optional telemetry emitter. */
  emitTelemetry?: (eventClass: string, payload: Record<string, unknown>) => Promise<void>
}

// ── Content extraction ─────────────────────────────────────────────────

/**
 * Extract plain text content from an LLM response object.
 *
 * Handles common response shapes:
 * - `{ response: string }` — gateway::route_llm wraps content in `response`
 * - `{ content: string }` — direct content field
 * - `{ success: true, response: { content: string } }` — RouteResult from failover
 * - Plain string — return as-is
 */
export function extractContent(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>

    // RouteSuccess shape: { success: true, response: { content: '...' } }
    if (obj.response !== null && typeof obj.response === 'object') {
      const resp = obj.response as Record<string, unknown>
      if (typeof resp.content === 'string' && resp.content.length > 0) {
        return resp.content
      }
    }

    // Direct content field
    if (typeof obj.content === 'string' && obj.content.length > 0) {
      return obj.content
    }

    // Gateway route_llm wraps in `response` key directly
    if (typeof obj.response === 'string') {
      return obj.response
    }
  }
  return JSON.stringify(raw)
}

// ── Peer review worker adapter ─────────────────────────────────────────

/**
 * Creates a pool of 4 peer-review worker adapters.
 *
 * Each worker wraps deps.trigger to submit a review prompt to an LLM,
 * then parses the numeric score from the response.
 *
 * The workers have distinct capability sets so the PeerReviewer selects
 * them for independent review.
 */
export function createReviewWorkerPool(
  deps: OrchestrateDeps,
  model: string,
): {
  getWorkers: () => Array<{
    id: string
    review: (payload: unknown) => Promise<{ score: number }>
    getCapabilities: () => string[]
  }>
} {
  const workers = [
    {
      id: 'reviewer-alpha',
      capabilities: ['reasoning', 'factual_accuracy'],
      reviewPrompt:
        'Review the following aggregated pipeline output for factual accuracy, coherence, and completeness. Score from 0.0 (unusable) to 1.0 (perfect). Return only a JSON object with a "score" field (number).',
    },
    {
      id: 'reviewer-beta',
      capabilities: ['hallucination_detection', 'consistency'],
      reviewPrompt:
        'Analyze the following aggregated pipeline output for hallucinations, contradictions, or inconsistencies. Score from 0.0 (severe issues) to 1.0 (no issues found). Return only a JSON object with a "score" field (number).',
    },
    {
      id: 'reviewer-gamma',
      capabilities: ['completeness', 'relevance'],
      reviewPrompt:
        'Evaluate the following aggregated pipeline output for completeness and relevance to the original request. Score from 0.0 (incomplete) to 1.0 (fully addresses all aspects). Return only a JSON object with a "score" field (number).',
    },
    {
      id: 'reviewer-delta',
      capabilities: ['security', 'robustness'],
      reviewPrompt:
        'Review the following aggregated pipeline output for security concerns, robustness, and overall quality. Score from 0.0 (unsafe) to 1.0 (production-ready). Return only a JSON object with a "score" field (number).',
    },
  ]

  return {
    getWorkers: () =>
      workers.map((w) => ({
        id: w.id,
        review: async (payload: unknown): Promise<{ score: number }> => {
          const result = await deps.trigger('gateway::route_llm', {
            model,
            messages: [
              { role: 'system', content: w.reviewPrompt },
              { role: 'user', content: JSON.stringify(payload) },
            ],
            temperature: 0,
          })
          // Parse score from the response — try multiple extraction strategies
          const text = extractContent(result)
          try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed.score === 'number') {
              return { score: Math.max(0, Math.min(1, parsed.score)) }
            }
          } catch {
            // Fallback: extract first decimal number from text
            const match = text.match(/(\d\.\d+)/)
            if (match) {
              const score = parseFloat(match[1])
              return { score: Math.max(0, Math.min(1, score)) }
            }
          }
          // Default moderate score
          return { score: 0.7 }
        },
        getCapabilities: () => w.capabilities,
      })),
  }
}

// ── Orchestrate ────────────────────────────────────────────────────────

export async function orchestrate(
  input: OrchestrateInput,
  deps: OrchestrateDeps,
  config?: OrchestrateConfig,
): Promise<OrchestrateResult> {
  const retryCap = config?.retryCap ?? 3
  const consensusThreshold = config?.consensusThreshold ?? 0.7
  const numReviewers = config?.numReviewers ?? 3
  const gateSpecs = config?.gateSpecs ?? {}

  // Emit telemetry
  await deps.emitTelemetry?.('ORCHESTRATE_STARTED', {
    requestId: input.requestId,
    model: input.model,
    messageCount: input.messages.length,
  })

  // ── 1. Decompose ────────────────────────────────────────────────
  const planner = new SimpleDAGPlanner()
  const plannerInput: PlannerInput = {
    model: input.model,
    messages: input.messages,
  }
  const taskDag = planner.plan(plannerInput)

  // ── 2. Convert TaskDAG to RunnableDag ────────────────────────────
  const runnableNodes: RunnableNode<unknown>[] = taskDag.nodes.map((node) => ({
    id: node.id,
    depends_on: node.depends_on,
    required_capability: undefined,
    execute: async (): Promise<unknown> => {
      const raw = await deps.trigger(node.function_id, node.payload)
      return extractContent(raw)
    },
  }))

  const runnableDag: RunnableDag<unknown> = { nodes: runnableNodes }

  // ── 3. Compute execution stages ─────────────────────────────────
  const stages = computeStages(runnableDag.nodes)

  const allResults = new Map<string, unknown>()
  let totalGatesPassed = 0
  let totalGatesFailed = 0
  let totalRetriesUsed = 0
  const stageDetails: StageDetail[] = []

  // ── 4. Execute stages with gate interleaving ─────────────────────
  for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
    const stage = stages[stageIdx]
    const stageNodeIds = stage.map((n) => n.id)
    const stageResults = new Map<string, string>()
    let stageGatesPassed = 0
    let stageGatesFailed = 0
    let stageRetries = 0

    // Execute all nodes in this stage concurrently
    const executionPromises = stage.map(async (node) => {
      let lastError: Error | undefined

      for (let attempt = 0; attempt <= retryCap; attempt++) {
        try {
          const result = await node.execute()
          const content = typeof result === 'string' ? result : String(result)
          return { nodeId: node.id, content, attempt }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          if (attempt < retryCap) {
            stageRetries++
            totalRetriesUsed++
          }
        }
      }

      throw new Error(
        `Node "${node.id}" failed after ${retryCap + 1} attempt(s): ${lastError?.message ?? 'unknown error'}`,
      )
    })

    const executionResults = await Promise.allSettled(executionPromises)

    for (const settled of executionResults) {
      if (settled.status === 'fulfilled') {
        const { nodeId, content } = settled.value
        stageResults.set(nodeId, content)
      }
    }

    // Check for node execution failures
    for (let i = 0; i < stage.length; i++) {
      if (executionResults[i].status === 'rejected') {
        throw executionResults[i].reason
      }
    }

    // ── 5. Apply quality gates to each result ──────────────────────
    const gatePromises: Promise<void>[] = []

    for (const [nodeId, content] of stageResults) {
      const spec = gateSpecs[nodeId]
      if (spec) {
        gatePromises.push(
          (async () => {
            const gateResult = evaluateGate(spec, content)

            if (gateResult.passed) {
              stageGatesPassed++
              totalGatesPassed++
            } else {
              // Gate failed — attempt retry with re-routed logic
              stageGatesFailed++
              totalGatesFailed++

              // Retry the node (up to retryCap times)
              for (let attempt = 0; attempt < retryCap; attempt++) {
                stageRetries++
                totalRetriesUsed++

                try {
                  // Re-execute the node via its function_id
                  const dagNode = taskDag.nodes.find((n) => n.id === nodeId)
                  const retryRaw = await deps.trigger(
                    dagNode?.function_id ?? '',
                    dagNode?.payload ?? {},
                  )
                  const retryContent = extractContent(retryRaw)
                  const retryGate = evaluateGate(spec, retryContent)

                  if (retryGate.passed) {
                    stageResults.set(nodeId, retryContent)
                    stageGatesPassed++
                    totalGatesPassed++
                    stageGatesFailed--
                    totalGatesFailed--
                    return // Exit retry loop on success
                  }
                } catch {
                  // Retry attempt failed, continue to next attempt
                }
              }

              // All retries exhausted — keep the original result but mark failure
            }
          })(),
        )
      }
    }

    await Promise.all(gatePromises)

    // Merge stage results into allResults
    for (const [id, content] of stageResults) {
      allResults.set(id, content)
    }

    stageDetails.push({
      stageIndex: stageIdx,
      nodeIds: stageNodeIds,
      gatesPassed: stageGatesPassed,
      gatesFailed: stageGatesFailed,
      retriesUsed: stageRetries,
    })
  }

  // ── 6. Aggregate results into a single prompt context ────────────
  const aggregatedContent = aggregateResults(
    allResults as Map<string, string>,
  )

  // ── 7. Peer review ──────────────────────────────────────────────
  const reviewWorkerPool = createReviewWorkerPool(deps, input.model)
  const reviewer = new PeerReviewer(
    {
      getWorkers: () =>
        reviewWorkerPool.getWorkers().map((w) => ({
          id: w.id,
          review: w.review,
          getCapabilities: w.getCapabilities,
        })),
    },
    consensusThreshold,
    numReviewers,
    // No SugarDB integration for telemetry in the orchestrator's PeerReviewer
    undefined,
  )

  const aggregatedResultPayload: AggregatedResult = {
    nodeResults: allResults,
  }

  const reviewOutcome = await reviewer.review(aggregatedResultPayload)

  // ── 8. Return final result ───────────────────────────────────────
  return {
    content: aggregatedContent,
    finishReason: 'stop',
    metadata: {
      stagesCompleted: stages.length,
      peerReviewConsensus: reviewOutcome.consensus,
      gatesPassed: totalGatesPassed,
      gatesFailed: totalGatesFailed,
      retriesUsed: totalRetriesUsed,
      nodeCount: taskDag.nodes.length,
      dagId: taskDag.root,
      stageDetails,
      reviewOutcome,
    },
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Aggregate node results into a single prompt context string.
 */
export function aggregateResults(results: Map<string, string>): string {
  const parts: string[] = []

  for (const [nodeId, content] of results) {
    parts.push(`[Node: ${nodeId}]\n${content}`)
  }

  return parts.join('\n\n')
}
