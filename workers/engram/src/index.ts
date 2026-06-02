import { registerWorker, type ISdk } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

export function createEngramWorker(url: string = ENGINE_URL): ISdk {
  const iii = registerWorker(url, { workerName: 'engram' })

  iii.registerFunction('engram::status', async () => {
    return { worker: 'engram', status: 'healthy', uptime: process.uptime() }
  })

  iii.registerFunction('engram::record', async (input: { event: string; data?: unknown }) => {
    return { recorded: true, event: input.event, worker: 'engram', timestamp: Date.now() }
  })

  iii.registerFunction('engram::recall', async (input: { query?: string }) => {
    return { results: [], query: input?.query ?? '', worker: 'engram', note: 'placeholder — will use iii-stream in later milestones' }
  })

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
