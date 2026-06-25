import { routeLlm, type RouteLlmDeps } from './workers/gateway/src/index.ts'
import { callEngramHeal } from './workers/gateway/src/heal-integration.ts'
import type { ISdk } from 'iii-sdk'

const TEST_PROVIDER_CONFIG = { baseUrl: 'https://test.example.com', envKey: 'TEST' }

const mockCallProvider = async () => ({
  id: 'chatcmpl-empty',
  content: '',
  finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
})

const mockTrigger = async (opts: any) => {
  if (opts.function_id === 'engram::heal_json') {
    console.log('[DEBUG] engram::heal_json called with payload keys:', Object.keys(opts.payload as object))
    return { success: true, data: { fixed: true, message: 'healed!' }, attempts: 1 }
  }
  return null
}

async function main() {
  const deps: RouteLlmDeps = {
    resolveModel: async (model) => ({ model, providers: ['test-provider/test-model'], resolved: true }),
    getKey: async () => 'test-api-key',
    callProvider: mockCallProvider as any,
    getProviderConfig: (providerId: string) => TEST_PROVIDER_CONFIG,
    iii: { trigger: mockTrigger } as unknown as ISdk,
    callEngramHeal,
  }

  const result = await routeLlm({ model: 'test', messages: [{ role: 'user', content: 'hello' }], stream: false }, deps)
  console.log('[DEBUG] result.success:', result.success)
  if ('response' in result) {
    const r = result as any
    console.log('[DEBUG] response keys:', Object.keys(r.response))
    console.log('[DEBUG] response.content:', r.response?.content)
    console.log('[DEBUG] response.choices[0]:', JSON.stringify(r.response?.choices?.[0]))
  }
}
main().catch(console.error)
