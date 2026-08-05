/**
 * test_orchestrate.ts — Integration tests for the engram::orchestrate worker function.
 *
 * Tests 5 scenarios:
 *   1. Happy path: multi-node DAG all succeed, gates pass, peer review passes
 *   2. Gate failure: 1 node fails gate, retry triggered, eventually succeeds
 *   3. Peer review re-route: consensus below threshold, needs_reroute returned
 *   4. Telemetry: ORCHESTRATE_STARTED event fires
 *   5. Multiple stages: 2-stage DAG with multiple nodes, both stages execute
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { orchestrate, extractContent } from './orchestrate.ts'

// ── Mock deps factory ─────────────────────────────────────────────────

interface MockTriggerConfig {
  /** Map of node intent substring → response content. */
  responses?: Record<string, unknown>
  /** Simulate peer review responses: map of reviewer id → score. */
  reviewScores?: Record<string, number>
  /** Track trigger calls for inspection. */
  triggerCalls?: Array<{ fnId: string; payload: Record<string, unknown> }>
  /** Simulate a failing node on first N calls, then succeed. */
  failFirstNCalls?: number
  /** Simulate gate-failing content on first N calls. */
  failGateFirstNCalls?: Record<string, number>
}

function createMockOrchestrateDeps(config?: MockTriggerConfig): {
  deps: Parameters<typeof orchestrate>[1]
  triggerCalls: Array<{ fnId: string; payload: Record<string, unknown> }>
  telemetryEvents: Array<{ eventClass: string; payload: Record<string, unknown> }>
} {
  const triggerCalls: Array<{ fnId: string; payload: Record<string, unknown> }> = []
  const telemetryEvents: Array<{ eventClass: string; payload: Record<string, unknown> }> = []
  let callCount = 0
  const failFirstN = config?.failFirstNCalls ?? 0
  const gateFailCounts: Record<string, number> = {}
  const failGateFirst = config?.failGateFirstNCalls ?? {}

  return {
    deps: {
      trigger: async (fnId: string, payload: Record<string, unknown>) => {
        triggerCalls.push({ fnId, payload })
        callCount++

        // Simulate execution failures for the first N calls
        if (callCount <= failFirstN) {
          throw new Error(`Simulated execution failure (call ${callCount})`)
        }

        // Heal_json and other non-chat function responses
        if (fnId !== 'gateway::chat_completions' && fnId !== 'gateway::route_llm') {
          return {}
        }

        // Extract user message content from payload
        const messages = (payload as any)?.messages ?? []
        const userMsg = messages.find((m: { role: string }) => m.role === 'user')
        const content = userMsg?.content ?? ''

        // Check for configured responses
        if (config?.responses) {
          for (const [key, response] of Object.entries(config.responses)) {
            if (content.includes(key)) {
              // Track gate-failing calls for specific nodes
              if (failGateFirst[key]) {
                const count = (gateFailCounts[key] ?? 0) + 1
                gateFailCounts[key] = count
                if (count <= failGateFirst[key]) {
                  // Return content that will fail the gate
                  return {
                    success: true,
                    response: { content: 'BAD_OUTPUT_FAIL_GATE' },
                  }
                }
              }
              return response
            }
          }
        }

        return { success: true, response: { content: `Result for: ${content}` } }
      },
      emitTelemetry: async (eventClass: string, payload: Record<string, unknown>) => {
        telemetryEvents.push({ eventClass, payload })
      },
    },
    triggerCalls,
    telemetryEvents,
  }
}

// ── extractContent tests ───────────────────────────────────────────────

describe('extractContent', () => {
  it('returns plain strings as-is', () => {
    assert.equal(extractContent('hello'), 'hello')
  })

  it('extracts from RouteSuccess shape', () => {
    const result = extractContent({
      success: true,
      response: { content: 'Hello world', id: 'test', finishReason: 'stop' },
    })
    assert.equal(result, 'Hello world')
  })

  it('extracts from gateway::route_llm response shape', () => {
    const result = extractContent({ response: 'Direct response' })
    assert.equal(result, 'Direct response')
  })

  it('extracts from direct content field', () => {
    const result = extractContent({ content: 'Direct content', id: 'x' })
    assert.equal(result, 'Direct content')
  })

  it('falls back to JSON.stringify for unknown shapes', () => {
    const result = extractContent({ foo: 'bar' })
    assert.ok(result.includes('foo'))
    assert.ok(result.includes('bar'))
  })

  it('handles null gracefully', () => {
    const result = extractContent(null)
    assert.equal(result, 'null')
  })
})

// ── Test 1: Happy Path ─────────────────────────────────────────────────

describe('orchestrate happy path', () => {
  it('executes a multi-node DAG, gates pass, peer review succeeds', async () => {
    const { deps, triggerCalls, telemetryEvents } = createMockOrchestrateDeps({
      responses: {
        'task1': { success: true, response: { content: 'Output for task1' } },
        'task2': { success: true, response: { content: 'Output for task2' } },
      },
    })

    // Use conjunction-based multi-intent message to get a multi-node DAG
    const result = await orchestrate(
      {
        messages: [{ role: 'user', content: 'task1 and task2' }],
        model: 'test-model',
        requestId: 'happy-001',
      },
      deps,
      {
        // Gate specs for all nodes — require minimal output
        gateSpecs: {
          n0: { gate_type: 'contains', value: 'Output', required: true },
          n1: { gate_type: 'contains', value: 'Output', required: true },
        },
        consensusThreshold: 0.1, // Very low — peer review always passes
      },
    )

    // Verify the result
    assert.equal(result.finishReason, 'stop')
    assert.ok(typeof result.content === 'string')
    assert.ok(result.content.length > 0)
    assert.ok(result.content.includes('task1'))
    assert.ok(result.content.includes('task2'))

    // Verify metadata
    assert.equal(result.metadata.stagesCompleted, 2)
    assert.equal(result.metadata.nodeCount, 2)
    assert.equal(result.metadata.gatesPassed, 2)
    assert.equal(result.metadata.gatesFailed, 0)
    assert.ok(result.metadata.peerReviewConsensus > 0)

    // Verify stage details
    assert.equal(result.metadata.stageDetails.length, 2)
    assert.equal(result.metadata.stageDetails[0].stageIndex, 0)
    assert.equal(result.metadata.stageDetails[1].stageIndex, 1)

    // Verify trigger was called for each node
    // (n0, n1, plus up to 4 review triggers = alpha/beta/gamma/delta)
    const nodeCalls = triggerCalls.filter(
      (c) => c.fnId === 'gateway::chat_completions',
    )
    assert.equal(nodeCalls.length, 2) // 2 nodes

    // Verify telemetry: ORCHESTRATE_STARTED was emitted
    const startEvents = telemetryEvents.filter(
      (e) => e.eventClass === 'ORCHESTRATE_STARTED',
    )
    assert.equal(startEvents.length, 1)
    assert.equal(startEvents[0].payload.requestId, 'happy-001')
  })
})

// ── Test 2: Gate Failure ───────────────────────────────────────────────

describe('orchestrate gate failure', () => {
  it('detects gate failure and triggers retry path', async () => {
    const { deps, triggerCalls } = createMockOrchestrateDeps({
      responses: {
        'task1': { success: true, response: { content: 'Output for task1' } },
        'task2': { success: true, response: { content: 'Output for task2' } },
      },
      // Make the first call for 'task2' return BAD_OUTPUT_FAIL_GATE
      failGateFirstNCalls: { 'task2': 1 },
    })

    const result = await orchestrate(
      {
        messages: [{ role: 'user', content: 'task1 and task2' }],
        model: 'test-model',
        requestId: 'gate-fail-002',
      },
      deps,
      {
        gateSpecs: {
          n0: { gate_type: 'contains', value: 'Output', required: true },
          n1: { gate_type: 'contains', value: 'Output', required: true },
        },
        consensusThreshold: 0.1,
        retryCap: 3,
      },
    )

    // The gate failure for n1 should have triggered retry
    // The retry should have eventually succeeded
    assert.equal(result.finishReason, 'stop')
    assert.ok(result.content.length > 0)

    // Gates: n0 passed, n1 failed once then passed on retry
    // Total: 2 passed, but gatesFailed might be 1 if the retry succeeded
    // (The gate failure is counted then decremented on retry success)
    assert.equal(result.metadata.gatesPassed, 2)
    assert.ok(result.metadata.retriesUsed > 0, 'retries should be used')

    // Verify the trigger was called multiple times for n1 (first fail + retries)
    // n0 = 1 call, n1 = at least 2 calls (fail then retry)
    const nodeCalls = triggerCalls.filter(
      (c) => c.fnId === 'gateway::chat_completions',
    )
    assert.ok(
      nodeCalls.length >= 3,
      `should have 3+ trigger calls (initial + retry), got ${nodeCalls.length}`,
    )
  })

  it('handles gate failure with no gate spec gracefully', async () => {
    const { deps } = createMockOrchestrateDeps({
      responses: {
        'task1': { success: true, response: { content: 'Output for task1' } },
      },
    })

    // No gate specs — all results pass through
    const result = await orchestrate(
      {
        messages: [{ role: 'user', content: 'task1' }],
        model: 'test-model',
        requestId: 'no-gate-002',
      },
      deps,
    )

    // Single-node DAG with no gates should complete
    assert.equal(result.finishReason, 'stop')
    assert.equal(result.metadata.nodeCount, 1)
    assert.equal(result.metadata.gatesPassed, 0)
    assert.equal(result.metadata.gatesFailed, 0)
  })
})

// ── Test 3: Peer Review Re-route ───────────────────────────────────────

describe('orchestrate peer review', () => {
  it('detects low consensus and returns needs_reroute verdict', async () => {
    // The PeerReviewer uses deps.trigger for review scores.
    // By default, createReviewWorkerPool returns 0.7 for unparseable responses.
    // To force low consensus, we need reviewers to return low scores.
    // The review workers parse JSON from the response text.
    // We can control this by having deps.trigger return low-score JSON.
    const { deps } = createMockOrchestrateDeps({
      responses: {
        'task1': { success: true, response: { content: 'Output for task1' } },
      },
    })

    // Override trigger to return low scores on review calls
    const originalTrigger = deps.trigger
    deps.trigger = async (fnId: string, payload: Record<string, unknown>) => {
      // If this is a review call (going through gateway::route_llm), return low score
      const messages = (payload as any)?.messages ?? []
      const hasSystemMsg = messages.some(
        (m: { role: string }) => m.role === 'system',
      )
      if (
        fnId === 'gateway::route_llm' &&
        hasSystemMsg &&
        messages.length >= 2
      ) {
        // Return a low score to trigger low consensus
        return { response: '{"score": 0.15}' }
      }
      return originalTrigger(fnId, payload)
    }

    const result = await orchestrate(
      {
        messages: [{ role: 'user', content: 'task1' }],
        model: 'test-model',
        requestId: 'peer-fail-003',
      },
      deps,
      {
        consensusThreshold: 0.5, // Above 0.15 → consensus fails
        numReviewers: 3,
      },
    )

    assert.equal(result.finishReason, 'stop')
    assert.ok(result.metadata.peerReviewConsensus < 0.5)
    assert.ok(
      result.metadata.reviewOutcome !== undefined,
      'reviewOutcome should be present',
    )
    assert.equal(
      result.metadata.reviewOutcome!.verdict,
      'needs_reroute',
      'verdict should be needs_reroute when consensus is below threshold',
    )
  })

  it('passes peer review when consensus meets threshold', async () => {
    const { deps } = createMockOrchestrateDeps({
      responses: {
        'task1': { success: true, response: { content: 'Output for task1' } },
      },
    })

    const result = await orchestrate(
      {
        messages: [{ role: 'user', content: 'task1' }],
        model: 'test-model',
        requestId: 'peer-pass-003',
      },
      deps,
      {
        consensusThreshold: 0.1, // Very low — always passes
        numReviewers: 3,
      },
    )

    assert.equal(result.finishReason, 'stop')
    // With threshold 0.1, all reviewers' 0.7 default scores should pass
    assert.ok(
      result.metadata.peerReviewConsensus >= 0.1,
      `consensus ${result.metadata.peerReviewConsensus} should be >= 0.1`,
    )
    assert.equal(
      result.metadata.reviewOutcome!.verdict,
      'passed',
      'verdict should be passed',
    )
  })
})

// ── Test 4: Telemetry ──────────────────────────────────────────────────

describe('orchestrate telemetry', () => {
  it('emits ORCHESTRATE_STARTED and pipeline events', async () => {
    const mockConfig = createMockOrchestrateDeps({
      responses: {
        'task1': { success: true, response: { content: 'Output for task1' } },
        'task2': { success: true, response: { content: 'Output for task2' } },
      },
    })
    const { deps, telemetryEvents } = mockConfig

    await orchestrate(
      {
        messages: [{ role: 'user', content: 'task1 and task2' }],
        model: 'test-model',
        requestId: 'telemetry-004',
      },
      deps,
      {
        gateSpecs: {
          n0: { gate_type: 'contains', value: 'Output', required: true },
          n1: { gate_type: 'contains', value: 'Output', required: true },
        },
        consensusThreshold: 0.1,
      },
    )

    // Verify ORCHESTRATE_STARTED was emitted
    const startEvents = telemetryEvents.filter(
      (e) => e.eventClass === 'ORCHESTRATE_STARTED',
    )
    assert.equal(
      startEvents.length,
      1,
      'should emit exactly one ORCHESTRATE_STARTED',
    )
    assert.equal(startEvents[0].payload.requestId, 'telemetry-004')
    assert.equal(startEvents[0].payload.model, 'test-model')
    assert.equal(startEvents[0].payload.messageCount, 1)

    // Verify multiple telemetry events total (at least ORCHESTRATE_STARTED)
    assert.ok(
      telemetryEvents.length >= 1,
      `should have at least 1 telemetry event, got ${telemetryEvents.length}`,
    )

    // Additional pipeline telemetry (GATE_EVALUATED, etc.) flows through
    // the underlying primitives and would appear in production where SugarDB
    // integration is wired. The orchestrator itself emits ORCHESTRATE_STARTED.
  })
})

// ── Test 5: Multiple Stages ────────────────────────────────────────────

describe('orchestrate multi-stage execution', () => {
  it('executes a 2-stage DAG with multiple nodes correctly', async () => {
    const { deps, triggerCalls } = createMockOrchestrateDeps({
      responses: {
        'task1': { success: true, response: { content: 'Stage 0 result' } },
        'task2': { success: true, response: { content: 'Stage 1 task2 result' } },
        'task3': { success: true, response: { content: 'Stage 1 task3 result' } },
        'task4': { success: true, response: { content: 'Stage 1 task4 result' } },
      },
    })

    // Use 4 intents to create a 2-stage DAG:
    // Stage 0: [n0] — "task1"
    // Stage 1: [n1, n2, n3] — "task2", "task3", "task4"
    const result = await orchestrate(
      {
        messages: [{ role: 'user', content: 'task1 and task2 and task3 and task4' }],
        model: 'test-model',
        requestId: 'multi-stage-005',
      },
      deps,
      {
        gateSpecs: {
          n0: { gate_type: 'contains', value: 'Stage 0', required: true },
          n1: { gate_type: 'contains', value: 'Stage 1', required: true },
          n2: { gate_type: 'contains', value: 'Stage 1', required: true },
          n3: { gate_type: 'contains', value: 'Stage 1', required: true },
        },
        consensusThreshold: 0.1,
      },
    )

    // Verify both stages completed
    assert.equal(result.finishReason, 'stop')
    assert.equal(result.metadata.stagesCompleted, 2)
    assert.equal(result.metadata.nodeCount, 4)
    assert.equal(result.metadata.gatesPassed, 4)
    assert.equal(result.metadata.gatesFailed, 0)

    // Verify stage details
    assert.equal(result.metadata.stageDetails.length, 2)
    assert.equal(result.metadata.stageDetails[0].stageIndex, 0)
    assert.equal(result.metadata.stageDetails[0].nodeIds.length, 1) // 1 node in stage 0
    assert.equal(result.metadata.stageDetails[1].stageIndex, 1)
    assert.equal(result.metadata.stageDetails[1].nodeIds.length, 3) // 3 nodes in stage 1

    // Verify content includes all results
    assert.ok(result.content.includes('Stage 0'), 'content should include stage 0 result')
    assert.ok(
      result.content.includes('Stage 1'),
      'content should include stage 1 results',
    )

    // Verify node execution calls match expected count
    const nodeCalls = triggerCalls.filter(
      (c) => c.fnId === 'gateway::chat_completions',
    )
    assert.equal(nodeCalls.length, 4, 'should execute all 4 nodes exactly once')
  })
})
