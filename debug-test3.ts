import { routeLlm, type RouteLlmDeps } from './workers/gateway/src/index.ts'
import { callEngramHeal } from './workers/gateway/src/heal-integration.ts'
import type { ISdk } from 'iii-sdk'

const mockTrigger = async (opts: any) => {
  console.log('[DEBUG] trigger called:', opts.function_id)
  if (opts.function_id === 'engram::heal_json') {
    return { success: false, error: 'parse_failed', attempts: 0 }
  }
  return null
}

let providerCallCount = 0
const mockCallProvider = async () => {
  providerCallCount++
  console.log('[DEBUG] callProvider called, count:', providerCallCount)
  if (providerCallCount === 1) {
    return { id: 'chatcmpl-empty', content: '', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } }
  }
  return { id: 'chatcmpl-second', content: 'second provider response', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
}

async function main() {
  const deps: RouteLlmDeps = {
    resolveModel: async (model) => ({ model, providers: ['test-provider/test-model', 'second-provider/test-model'], resolved: true }),
    getKey: async () => 'test-api-key',
    callProvider: mockCallProvider as any,
    getProviderConfig: (providerId: string) => {
      console.log('[DEBUG] getProviderConfig called for:', providerId)
      return { baseUrl: 'https://test.example.com', envKey: 'TEST' }
    },
    iii: { trigger: mockTrigger } as unknown as ISdk,
    callEngramHeal,
  }
  const result = await routeLlm({ model: 'test', messages: [{ role: 'user', content: 'hello' }], stream: false }, deps)
  console.log('[DEBUG] result:', JSON.stringify(result))
}
main().catch(console.error)
