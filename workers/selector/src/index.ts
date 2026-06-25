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
import { startHealthEndpoint, waitForHealthEndpoint } from './health-endpoint.ts'
import { ClusterDiscovery, HttpTailscaleTransport } from '../../shared/cluster-discovery.ts'
import { OffloadRouter } from '../../shared/offload-router.ts'

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

interface OffloadRouterState {
  router: OffloadRouter
  discovery: ClusterDiscovery
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
  // Store health handle in outer scope so shutdown handlers can access it
  let healthHandle: ReturnType<typeof startHealthEndpoint> | null = null
  const iii = registerWorker(url, { workerName: 'selector' })

  let selector: Selector | null = null
  let slmAvailable = false
  let resolvedModel = factoryOptions.modelPath ?? 'qwen2.5-0.5b-instruct-q4_k_m'
  const offloadEnabled = process.env.SELECTOR_OFFLOAD_ENABLED === 'true'
  const peersUrl = process.env.SELECTOR_PEERS_URL
  let offloadState: OffloadRouterState | null = null

  // Derive a human-readable model name from the model path for the health endpoint
  const healthModelName = resolvedModel
    .replace(/.*[/\\]/, '')   // strip directory
    .replace(/\.[^.]+$/, '')   // strip extension

  // Health endpoint (optional, gated by SELECTOR_HEALTH_PORT env)
  const healthPortRaw = process.env.SELECTOR_HEALTH_PORT
  healthHandle = healthPortRaw !== undefined && healthPortRaw !== '' && healthPortRaw !== 'disabled'
    ? startHealthEndpoint(parseInt(healthPortRaw, 10) || 0, healthModelName, { current: 'healthy' })
    : null

  // Probe llama-cli + GGUF model availability on startup
  const ready = (async () => {
    try {
      selector = await createSelectorAsync(factoryOptions)
      slmAvailable = selector instanceof SLMSelector
      console.log(
        `[selector] Initialized with ${slmAvailable ? 'SLMSelector' : 'HeuristicSelector'}` +
        (slmAvailable ? ` (model: ${resolvedModel})` : ' (fallback)'),
      )

      // When offload is enabled, wrap the selector in an OffloadRouter
      // that forwards classification to healthy cluster peers.
      if (offloadEnabled && selector) {
        const discovery = new ClusterDiscovery(
          { telemetryDeps: undefined, sourceWorker: 'selector' },
          new HttpTailscaleTransport(peersUrl),
        )
        await discovery.start()
        offloadState = {
          router: new OffloadRouter({
            localSelector: selector,
            clusterDiscovery: discovery,
            telemetryDeps: undefined,
          }),
          discovery,
        }
        console.log(`[selector] OffloadRouter enabled (peers: ${peersUrl ?? 'default'})`)
      }
    } catch (err) {
      console.warn('[selector] Factory probe failed, using HeuristicSelector:', err)
      const { HeuristicSelector } = await import('../../vault/src/selector.ts')
      selector = new HeuristicSelector()
      slmAvailable = false
    }
  })()

  // Wait for health endpoint to be ready after selector is initialized
  if (healthHandle) {
    ready.then(() => waitForHealthEndpoint(healthHandle).catch(() => {}))
  }

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
      let classification: Classification

      if (offloadState) {
        // Offload to peer cluster if a healthy peer is available
        classification = await offloadState.router.classify(request)
      } else {
        // SLMSelector.classify() is async; HeuristicSelector.classify() is sync.
        // We handle both by checking and awaiting if needed.
        const result = selector.classify(request)
        classification = result instanceof Promise ? await result : result
      }

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
