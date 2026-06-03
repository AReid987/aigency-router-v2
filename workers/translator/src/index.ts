import { registerWorker, type ISdk } from 'iii-sdk'
import { CANONICAL_MAP } from './canonical-maps.ts'
import { logTelemetry } from '../../shared/telemetry.ts'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

export interface ResolveResult {
  model: string
  providers: string[]
  resolved: boolean
}

export function resolveModel(model: string): ResolveResult {
  if (!model || !model.trim()) {
    return { model, providers: [], resolved: false }
  }
  const providers = CANONICAL_MAP[model]
  if (providers) {
    return { model, providers, resolved: true }
  }
  return { model, providers: [model], resolved: false }
}

export function createTranslatorWorker(url: string = ENGINE_URL): ISdk {
  const iii = registerWorker(url, { workerName: 'translator' })

  iii.registerFunction('translator::status', async () => {
    return { worker: 'translator', status: 'healthy', uptime: process.uptime() }
  })

  iii.registerFunction('translator::translate', async (input: { text: string; from?: string; to?: string }) => {
    return {
      translated: `[mock] ${input.text}`,
      from: input.from ?? 'auto',
      to: input.to ?? 'en',
      worker: 'translator',
      note: 'placeholder — will integrate real translation in later milestones'
    }
  })

  iii.registerFunction('translator::detect', async (input: { text: string }) => {
    return { detected: 'en', confidence: 0.95, worker: 'translator' }
  })

  iii.registerFunction('translator::resolve', async (input: { model: string }) => {
    const result = resolveModel(input.model)
    console.log(`[translator] resolve: "${input.model}" → resolved=${result.resolved}, providers=${result.providers.length}`)

    // Fire-and-forget telemetry: emit PROVIDER_RESOLVED on provider resolution
    const telemetryTrigger = (target: string, fnName: string, payload: unknown) =>
      iii.trigger({ function_id: fnName, payload: payload as Record<string, unknown> })
    logTelemetry({ trigger: telemetryTrigger }, {
      eventClass: 'PROVIDER_RESOLVED',
      sourceWorker: 'translator',
      payload: { model: input.model, resolved: result.resolved, providerCount: result.providers.length },
    }).catch(() => {})

    return result
  })

  return iii
}

// Start if run directly
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const iii = createTranslatorWorker()
  console.log('[translator] Worker registered — listening on', ENGINE_URL)

  process.on('SIGTERM', async () => {
    await iii.shutdown()
    process.exit(0)
  })
}
