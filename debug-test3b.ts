import { FailoverEngine } from './workers/gateway/src/failover.ts'
import { callEngramHeal } from './workers/gateway/src/heal-integration.ts'
import type { ISdk } from 'iii-sdk'

const mockTrigger = async (opts: any) => {
  console.log('[DEBUG] trigger:', opts.function_id)
  if (opts.function_id === 'engram::heal_json') {
    console.log('[DEBUG] returning success: false')
    return { success: false, error: 'parse_failed', attempts: 0 }
  }
  return null
}

let providerCallCount = 0
const mockCallProvider = async (config: any, apiKey: string, model: string) => {
  providerCallCount++
  console.log('[DEBUG] callProvider #', providerCallCount, 'model:', model)
  if (providerCallCount === 1) {
    return { id: 'chatcmpl-empty', content: '', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } }
  }
  return { id: 'chatcmpl-second', content: 'second provider response', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
}

async function main() {
  const engine = new FailoverEngine(
    async () => 'test-key',
    mockCallProvider as any,
    (providerId: string) => ({ baseUrl: 'https://test.example.com', envKey: 'TEST' }),
  )
  
  // Wire the heal
  const iii = { trigger: mockTrigger } as unknown as ISdk
  engine.tryHeal = async (rawBody) => {
    const callHeal = callEngramHeal(iii, 2000)
    const healed = await callHeal(rawBody, 2000)
    console.log('[DEBUG] tryHeal called, healed:', healed)
    if (healed == null || typeof healed !== 'object') return null
    const obj = healed as { repaired?: unknown }
    if (typeof obj.repaired !== 'string') return null
    return {
      id: 'chatcmpl-healed',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'test',
      content: obj.repaired,
      choices: [{ index: 0, message: { role: 'assistant', content: obj.repaired }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
  }
  
  const result = await engine.routeWithFailover(
    ['test-provider/test-model', 'second-provider/test-model'],
    'test-model',
    [{ role: 'user', content: 'hello' }],
    { stream: false },
  )
  console.log('[DEBUG] final result:', JSON.stringify(result))
}
main().catch(console.error)
