/**
 * Selector iii Worker
 *
 * Bridges the TypeScript Selector interface to the iii worker architecture.
 * The brain worker (Python) calls `selector::classify` via iii trigger instead
 * of reimplementing classification logic in Python.
 *
 * Functions:
 *   selector::classify — classify a model request as simple/complex
 *   selector::status   — health check with SLM availability info
 */

import { registerWorker, type ISdk } from 'iii-sdk'
import { createSelectorAsync, type SelectorFactoryOptions } from '../../shared/selector-factory.ts'
import { SLMSelector } from '../../shared/slm-selector.ts'
import { logTelemetry } from '../../shared/telemetry.ts'
import type { Selector, ModelRequest, Classification } from '../../vault/src/selector.ts'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

interface ClassifyInput {
  model: string
  messages: Array<{ role: string; content: string }>
  enforce_json?: boolean
  max_tokens?: number
}

interface ClassifyResult {
  classification: Classification
  confidence: number
  source: 'slm' | 'heuristic'
  model: string
  latencyMs: number
}

interface StatusResult {
  status: 'healthy'
  worker: 'selector'
  slmAvailable: boolean
  model: string
}

export function createSelectorWorker(
  url: string = ENGINE_URL,
  factoryOptions: SelectorFactoryOptions = {},
): { iii: ISdk; ready: Promise<void> } {
  const iii = registerWorker(url, { workerName: 'selector' })

  let selector: Selector | null = null
  let slmAvailable = false
  let resolvedModel = factoryOptions.modelPath ?? 'qwen2.5-0.5b-instruct-q4_k_m'

  // Probe llama-cli + GGUF model availability on startup
  const ready = (async () => {
    try {
      selector = await createSelectorAsync(factoryOptions)
      slmAvailable = selector instanceof SLMSelector
      console.log(
        `[selector] Initialized with ${slmAvailable ? 'SLMSelector' : 'HeuristicSelector'}` +
        (slmAvailable ? ` (model: ${resolvedModel})` : ' (fallback)'),
      )
    } catch (err) {
      console.warn('[selector] Factory probe failed, using HeuristicSelector:', err)
      const { HeuristicSelector } = await import('../../vault/src/selector.ts')
      selector = new HeuristicSelector()
      slmAvailable = false
    }
  })()

  iii.registerFunction('selector::classify', async (input: ClassifyInput): Promise<ClassifyResult> => {
    // Ensure selector is initialized
    await ready

    if (!selector) {
      return {
        classification: 'complex',
        confidence: 0,
        source: 'heuristic',
        model: input.model,
        latencyMs: 0,
      }
    }

    const request: ModelRequest = {
      model: input.model,
      messages: input.messages,
      ...(input.enforce_json !== undefined ? { enforce_json: input.enforce_json } : {}),
      ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
    }

    const start = Date.now()

    try {
      // SLMSelector.classify() is async; HeuristicSelector.classify() is sync.
      // We handle both by checking and awaiting if needed.
      const result = selector.classify(request)
      const classification: Classification = result instanceof Promise ? await result : result
      const latencyMs = Date.now() - start

      // Emit telemetry
      await logTelemetry(
        { trigger: (target: string, fnName: string, payload: unknown) => iii.trigger({ function_id: fnName, payload: payload as Record<string, unknown> }) },
        {
          eventClass: 'SLM_CLASSIFY',
          sourceWorker: 'selector',
          payload: {
            model: input.model,
            latencyMs,
            classification,
            source: slmAvailable ? 'slm' : 'heuristic',
          },
        },
      ).catch(() => {})

      return {
        classification,
        confidence: slmAvailable ? 0.85 : 0.6,
        source: slmAvailable ? 'slm' : 'heuristic',
        model: input.model,
        latencyMs,
      }
    } catch (err: unknown) {
      const latencyMs = Date.now() - start
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[selector] Classification failed (${latencyMs}ms), defaulting to complex:`, msg)

      return {
        classification: 'complex',
        confidence: 0,
        source: slmAvailable ? 'slm' : 'heuristic',
        model: input.model,
        latencyMs,
      }
    }
  })

  iii.registerFunction('selector::status', async (): Promise<StatusResult> => {
    await ready
    return {
      status: 'healthy',
      worker: 'selector',
      slmAvailable,
      model: resolvedModel,
    }
  })

  return { iii, ready }
}

// Start if run directly
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const { iii, ready } = createSelectorWorker(ENGINE_URL)
  await ready
  console.log('[selector] Worker registered — listening on', ENGINE_URL)

  process.on('SIGTERM', async () => {
    await iii.shutdown()
    process.exit(0)
  })
}
