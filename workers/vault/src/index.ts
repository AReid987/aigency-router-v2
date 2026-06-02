import { registerWorker, type ISdk } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

export function createVaultWorker(url: string = ENGINE_URL): ISdk {
  const iii = registerWorker(url, { workerName: 'vault' })

  iii.registerFunction('vault::status', async () => {
    return { worker: 'vault', status: 'healthy', uptime: process.uptime() }
  })

  iii.registerFunction('vault::store', async (input: { key: string; value: unknown }) => {
    return { stored: true, key: input.key, worker: 'vault' }
  })

  iii.registerFunction('vault::retrieve', async (input: { key: string }) => {
    return { key: input.key, value: null, worker: 'vault', note: 'placeholder — will use iii-state in later milestones' }
  })

  return iii
}

// Start if run directly
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const iii = createVaultWorker()
  console.log('[vault] Worker registered — listening on', ENGINE_URL)

  process.on('SIGTERM', async () => {
    await iii.shutdown()
    process.exit(0)
  })
}
