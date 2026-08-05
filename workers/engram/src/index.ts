import { registerWorker, type ISdk } from 'iii-sdk'
import { healJson, type HealJsonDeps, type Message } from './heal-json.js'
import { parse as parseGate, evaluate as evaluateGate } from './quality_gate.js'
import { HallucinationDetector } from './hallucination_detector.js'
import { logTelemetry } from '../../shared/telemetry.ts'
import { orchestrate, type OrchestrateInput } from './orchestrate.ts'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

/**
 * Build HealJsonDeps wired to iii.trigger for gateway::route_llm.
 */
export function buildHealJsonDeps(iii: ISdk): HealJsonDeps {
  return {
    callGateway: async (model: string, messages: Message[]): Promise<string> => {
      const result = await iii.trigger('gateway::route_llm', {
        model,
        messages,
        temperature: 0,
      })
      // gateway::route_llm returns { response: string }
      if (typeof result === 'object' && result !== null && 'response' in result) {
        return (result as { response: string }).response
      }
      // If the result is already a string, use it directly
      if (typeof result === 'string') return result
      // Fallback: stringify
      return JSON.stringify(result)
    },
  }
}

/**
 * Register engram functions on a given iii SDK instance.
 * Extracted for testability — tests can pass a mock SDK.
 */
export function registerEngramFunctions(iii: ISdk): void {
  iii.registerFunction('engram::status', async () => {
    return { worker: 'engram', status: 'healthy', uptime: process.uptime() }
  })

  iii.registerFunction('engram::record', async (input: { event: string; data?: unknown }) => {
    return { recorded: true, event: input.event, worker: 'engram', timestamp: Date.now() }
  })

  iii.registerFunction('engram::recall', async (input: { query?: string }) => {
    return { results: [], query: input?.query ?? '', worker: 'engram', note: 'placeholder — will use iii-stream in later milestones' }
  })

  // ── engram::gate (Quality Gate Evaluation) ─────────────────────
  iii.registerFunction('engram::gate', async (input: {
    spec: Record<string, unknown>
    output: string
    reference_text?: string
  }) => {
    if (!input || typeof input.spec !== 'object' || typeof input.output !== 'string') {
      return {
        passed: false,
        reasons: ['Missing or invalid spec/output fields'],
        hallucination_score: null,
      }
    }

    try {
      // Parse the spec
      const gateSpec = parseGate(input.spec)

      // Evaluate the gate
      const gateResult = evaluateGate(gateSpec, input.output, input.reference_text)

      let hallucinationScore: number | null = null

      // Run hallucination detection if reference_text is provided
      if (input.reference_text) {
        const embedFn = (text: string) => {
          // Simple character n-gram based embedding for basic detection
          // In production, wire to sentence-transformers or similar
          const bigrams = new Map<string, number>()
          const t = text.toLowerCase()
          for (let i = 0; i < t.length - 1; i++) {
            const bg = t.slice(i, i + 2)
            bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1)
          }
          // Normalize to a fixed-length vector by indexing known bigrams
          const vec: number[] = []
          for (let i = 0; i < t.length - 1; i++) {
            vec.push(bigrams.get(t.slice(i, i + 2)) ?? 0)
          }
          // Pad or truncate to 64 dimensions
          while (vec.length < 64) vec.push(0)
          return vec.slice(0, 64)
        }

        const detector = new HallucinationDetector(embedFn, 0.6)
        const hResult = await detector.evaluate(input.output, input.reference_text)
        hallucinationScore = hResult.score

        // Emit GATE_HALLUCINATION_DETECTED telemetry
        const telemetryTrigger = (target: string, fnName: string, payload: unknown) =>
          iii.trigger({ function_id: fnName, payload: payload as Record<string, unknown> })
        logTelemetry({ trigger: telemetryTrigger }, {
          eventClass: 'GATE_HALLUCINATION_DETECTED',
          sourceWorker: 'engram',
          payload: {
            score: hResult.score,
            isHallucination: hResult.isHallucination,
            gateType: gateSpec.gate_type,
          },
        }).catch(() => {})
      }

      // Emit telemetry
      const telemetryTrigger = (target: string, fnName: string, payload: unknown) =>
        iii.trigger({ function_id: fnName, payload: payload as Record<string, unknown> })

      if (!gateResult.passed) {
        logTelemetry({ trigger: telemetryTrigger }, {
          eventClass: 'GATE_FAILED',
          sourceWorker: 'engram',
          payload: {
            gateType: gateSpec.gate_type,
            reasons: gateResult.reasons,
            hallucinationScore,
          },
        }).catch(() => {})
      } else {
        logTelemetry({ trigger: telemetryTrigger }, {
          eventClass: 'GATE_EVALUATED',
          sourceWorker: 'engram',
          payload: {
            gateType: gateSpec.gate_type,
            passed: gateResult.passed,
            hallucinationScore,
          },
        }).catch(() => {})
      }

      return {
        passed: gateResult.passed,
        reasons: gateResult.reasons,
        hallucination_score: hallucinationScore,
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err)
      return {
        passed: false,
        reasons: [`Gate evaluation error: ${error}`],
        hallucination_score: null,
      }
    }
  })

  // ── engram::orchestrate (Full Pipeline Orchestrator) ────────────
  iii.registerFunction('engram::orchestrate', async (input: OrchestrateInput) => {
    if (!input || !Array.isArray(input.messages) || typeof input.model !== 'string') {
      return {
        content: '',
        finishReason: 'stop' as const,
        metadata: {
          stagesCompleted: 0,
          peerReviewConsensus: 0,
          gatesPassed: 0,
          gatesFailed: 1,
          retriesUsed: 0,
          nodeCount: 0,
          dagId: '',
          stageDetails: [],
        },
      }
    }

    const telemetryTrigger = (target: string, fnName: string, payload: unknown) =>
      iii.trigger({ function_id: fnName, payload: payload as Record<string, unknown> })

    const deps = {
      trigger: async (fnId: string, payload: Record<string, unknown>): Promise<unknown> => {
        return iii.trigger({ function_id: fnId, payload })
      },
      emitTelemetry: async (eventClass: string, payload: Record<string, unknown>) => {
        await logTelemetry({ trigger: telemetryTrigger }, {
          eventClass: eventClass as any,
          sourceWorker: 'engram',
          payload,
        }).catch(() => {})
      },
    }

    return orchestrate(input, deps)
  })

  // Register heal_json function (T03: Worker Wiring + Integration)
  iii.registerFunction('engram::heal_json', async (input: { jsonString: string; model?: string }) => {
    if (!input || typeof input.jsonString !== 'string') {
      return {
        success: false,
        error: 'Missing or invalid jsonString field — expected string',
        attempts: 0,
      }
    }

    const deps = buildHealJsonDeps(iii)
    const result = await healJson(
      {
        jsonString: input.jsonString,
        model: input.model,
      },
      deps,
    )

    // Fire-and-forget telemetry: emit DRIFT_HEALED on successful JSON repair
    if (result.success) {
      const telemetryTrigger = (target: string, fnName: string, payload: unknown) =>
        iii.trigger({ function_id: fnName, payload: payload as Record<string, unknown> })
      logTelemetry({ trigger: telemetryTrigger }, {
        eventClass: 'DRIFT_HEALED',
        sourceWorker: 'engram',
        payload: { attempts: result.attempts, model: input.model ?? null },
      }).catch(() => {})
    }

    return result
  })
}

export function createEngramWorker(url: string = ENGINE_URL): ISdk {
  const iii = registerWorker(url, { workerName: 'engram' })
  registerEngramFunctions(iii)
  return iii
}

// Start if run directly
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const iii = createEngramWorker()
  console.log('[engram] Worker registered — listening on', ENGINE_URL)

  process.on('SIGTERM', async () => {
    await iii.shutdown()
    process.exit(0)
  })
}
