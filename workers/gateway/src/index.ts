import { registerWorker, type ISdk } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

export function createGatewayWorker(url: string = ENGINE_URL): ISdk {
  const iii = registerWorker(url, { workerName: 'gateway' })

  iii.registerFunction('gateway::echo', async (input: { message?: string }) => {
    return { echo: input?.message ?? 'pong', worker: 'gateway', timestamp: Date.now() }
  })

  iii.registerFunction('gateway::status', async () => {
    return { worker: 'gateway', status: 'healthy', uptime: process.uptime() }
  })

  iii.registerFunction('gateway::route', async (input: { target: string; payload?: unknown }) => {
    const result = await iii.trigger({ function_id: input.target, payload: input.payload ?? {} })
    return { routed_to: input.target, result }
  })

  return iii
}

// Start if run directly
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const iii = createGatewayWorker()
  console.log('[gateway] Worker registered — listening on', ENGINE_URL)

  process.on('SIGTERM', async () => {
    await iii.shutdown()
    process.exit(0)
  })
}
