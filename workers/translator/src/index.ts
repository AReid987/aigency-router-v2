import { registerWorker, type ISdk } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

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
