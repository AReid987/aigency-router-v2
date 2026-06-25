/**
 * http-handler-zero-cost.test.ts — Unit tests for zero-cost circuit breaker
 * integration in the real http-handler chat-completions route.
 *
 * Tests:
 *   (a) Off-mode (GATEWAY_ZERO_COST_ENFORCEMENT unset): direct passthrough
 *   (b) On-mode + paid-tier (openai): refused with 503
 *   (c) On-mode + exhausted free-tier: refused with 503
 *   (d) On-mode + free-tier under-quota: success, usage recorded
 *   (e) All providers refused: 503 with aggregated reasons array
 *
 * Run: cd workers/gateway && tsx --test src/http-handler-zero-cost.test.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// ── Env vars that affect zero-cost and related behavior ────────────────

const ENV_KEYS = [
  'GATEWAY_ZERO_COST_ENFORCEMENT',
  'GATEWAY_ZERO_COST_DB_PATH',
  'GATEWAY_ZERO_COST_GROQ_LIMIT',
  'GATEWAY_ZERO_COST_CEREBRAS_LIMIT',
  'GATEWAY_ZERO_COST_TOGETHER_LIMIT',
  'GATEWAY_QUOTA_MONITORING',
  'GATEWAY_USE_ENGRAM_PIPELINE',
]

// ── Mock Helpers ───────────────────────────────────────────────────────

/**
 * Create a mock iii function invocation that the http() wrapper expects.
 * Follows the same pattern as http-handler.test.ts.
 */
function mockInvocation(body: unknown) {
  const written: string[] = []
  let closed = false
  let statusCode = 200
  let headers: Record<string, string> = {}
  const stream = new EventEmitter() as any
  stream.write = (data: string) => { written.push(data); return true }
  stream.end = (data?: string) => { if (data) written.push(data); closed = true; stream.emit('end') }
  stream.on = stream.on.bind(stream)
  stream.removeListener = stream.removeListener.bind(stream)

  const sendMessage = (msg: string) => {
    try {
      const parsed = JSON.parse(msg)
      if (parsed.type === 'set_status') statusCode = parsed.status_code
      if (parsed.type === 'set_headers') headers = { ...headers, ...parsed.headers }
    } catch { /* skip */ }
  }

  return {
    body,
    method: 'POST',
    path: '/v1/chat/completions',
    response: {
      sendMessage,
      stream,
      close: () => { closed = true },
    },
    _written: written,
    _closed: () => closed,
    _statusCode: () => statusCode,
    _headers: () => headers,
  }
}

function mockReader(messages: string[] = ['chunk-1']) {
  const stream = new EventEmitter()
  let closed = false
  const callbacks: ((msg: string) => void)[] = []

  const deliver = () => {
    for (const msg of messages) {
      for (const cb of callbacks) cb(msg)
    }
    setTimeout(() => stream.emit('end'), 5)
  }

  return {
    onMessage(cb: (msg: string) => void) {
      callbacks.push(cb)
      if (callbacks.length === 1) setTimeout(deliver, 2)
    },
    close() { closed = true },
    stream,
    get _closed() { return closed },
  }
}

/**
 * Mock callProvider that returns a non-streaming response with usage info.
 */
function mockNonStreamingCallProvider(content: string = 'Hello!') {
  return async (...args: any[]) => {
    const options = args[4] ?? {}
    if (options.stream) {
      return (async function* () {
        yield { id: 'c1', delta: content, finishReason: null }
        yield { id: 'c1', delta: '', finishReason: 'stop' }
      })()
    }
    return { content, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  }
}

/**
 * Mock iii SDK that returns controlled responses for translator::resolve
 * and vault::retrieve.
 */
function mockIII(overrides: {
  channelReader?: ReturnType<typeof mockReader>
  callProvider?: (...args: any[]) => Promise<any>
  providers?: string[]
} = {}) {
  const providers = overrides.providers ?? ['groq/gpt-4']
  return {
    trigger: async (opts: { function_id: string; payload: unknown }) => {
      if (opts.function_id === 'translator::resolve') return { model: 'gpt-4', providers, resolved: true }
      if (opts.function_id === 'vault::retrieve') return { key: 'sk-test' }
      if (opts.function_id === 'brain::classify') return { classification: 'SIMPLE', confidence: 0.9 }
      return {}
    },
    createChannel: async () => ({
      writer: { sendMessage() {}, close() {} },
      reader: overrides.channelReader ?? mockReader(['data: chunk']),
      writerRef: { channel_id: 'ch', access_key: 'k', direction: 'write' as const },
      readerRef: { channel_id: 'ch', access_key: 'k', direction: 'read' as const },
    }),
    registerFunction: () => ({ id: 'f', unregister() {} }),
    registerTrigger: () => ({ unregister() {} }),
    registerTriggerType: () => ({ id: 't', unregister() {} }),
    unregisterTriggerType: () => {},
    createStream: () => {},
    shutdown: async () => {},
    _callProvider: overrides.callProvider,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('HTTP handler: zero-cost enforcement', () => {
  let savedEnv: Record<string, string | undefined> = {}

  before(() => {
    // Save and clear relevant env vars so each test starts clean
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  after(() => {
    // Restore saved env vars
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  })

  // ── (a) Off-mode ──────────────────────────────────────────────────

  it('(a) Off-mode: no circuit-breaker involvement, direct passthrough', async () => {
    // GATEWAY_ZERO_COST_ENFORCEMENT not set → ensureZeroCostBreaker returns null
    process.env.GATEWAY_ZERO_COST_DB_PATH = ':memory:'

    const iii = mockIII({
      providers: ['groq/gpt-4'],
      callProvider: mockNonStreamingCallProvider('off-mode-ok'),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    assert.equal(inv._statusCode(), 200, 'off-mode: should succeed')
    const body = JSON.parse(inv._written.join(''))
    assert.equal(body.choices[0].message.content, 'off-mode-ok', 'off-mode: should get provider response')
  })

  // ── (d) On-mode + free-tier under-quota ───────────────────────────
  // MUST run before (c) to create the singleton with groq limit=1

  it('(d) On-mode + free-tier under-quota: success, usage recorded', async () => {
    process.env.GATEWAY_ZERO_COST_ENFORCEMENT = 'true'
    process.env.GATEWAY_ZERO_COST_DB_PATH = ':memory:'
    process.env.GATEWAY_ZERO_COST_GROQ_LIMIT = '1'

    const iii = mockIII({
      providers: ['groq/gpt-4'],
      callProvider: mockNonStreamingCallProvider('under-quota-ok'),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    assert.equal(inv._statusCode(), 200, 'under-quota: should succeed')
    const body = JSON.parse(inv._written.join(''))
    assert.equal(body.choices[0].message.content, 'under-quota-ok', 'under-quota: should get provider response')
  })

  // ── (c) On-mode + exhausted free-tier ─────────────────────────────
  // Singleton was created by (d) with groq limit=1 and 1 usage recorded

  it('(c) On-mode + exhausted free-tier: refused with 503', async () => {
    process.env.GATEWAY_ZERO_COST_ENFORCEMENT = 'true'

    const iii = mockIII({
      providers: ['groq/gpt-4'],
      // This callProvider should NEVER be called since groq is exhausted
      callProvider: mockNonStreamingCallProvider('should-not-be-called'),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    assert.equal(inv._statusCode(), 503, 'exhausted: should return 503')
    const body = JSON.parse(inv._written.join(''))
    assert.equal(body.error?.code, 'no_healthy_provider', 'exhausted: code must be no_healthy_provider')
    assert.ok(body.error?.reasons?.includes('exhausted'), 'exhausted: reasons must include exhausted')
  })

  // ── (b) On-mode + paid-tier ───────────────────────────────────────

  it('(b) On-mode + paid-tier (openai): refused with 503', async () => {
    process.env.GATEWAY_ZERO_COST_ENFORCEMENT = 'true'

    const iii = mockIII({
      providers: ['openai/gpt-4'],
      callProvider: mockNonStreamingCallProvider('should-not-be-called'),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    assert.equal(inv._statusCode(), 503, 'paid-tier: should return 503')
    const body = JSON.parse(inv._written.join(''))
    assert.equal(body.error?.code, 'no_healthy_provider', 'paid-tier: code must be no_healthy_provider')
    assert.ok(body.error?.reasons?.includes('paid_tier'), 'paid-tier: reasons must include paid_tier')
  })

  // ── (e) All providers refused ─────────────────────────────────────

  it('(e) All providers refused: 503 with aggregated reasons', async () => {
    process.env.GATEWAY_ZERO_COST_ENFORCEMENT = 'true'

    const iii = mockIII({
      providers: ['openai/gpt-4', 'anthropic/claude'],
      callProvider: mockNonStreamingCallProvider('should-not-be-called'),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    assert.equal(inv._statusCode(), 503, 'all-refused: should return 503')
    const body = JSON.parse(inv._written.join(''))
    assert.equal(body.error?.code, 'no_healthy_provider', 'all-refused: code must be no_healthy_provider')
    assert.ok(body.error?.reasons?.includes('paid_tier'), 'all-refused: reasons must include paid_tier')
  })
})
