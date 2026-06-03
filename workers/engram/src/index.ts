import { registerWorker, type ISdk } from 'iii-sdk'
import { healJson, type HealJsonDeps, type Message } from './heal-json.js'

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
