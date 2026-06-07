/**
 * E2E Integration Tests — Full routing path with mocked pipeline.
 *
 * Tests the complete chain: HTTP request → parse → brain classify →
 * translator resolve → vault retrieve → provider call → SSE/JSON response.
 *
 * All external dependencies are mocked — no iii Engine or real API keys needed.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// ── Mock Helpers ───────────────────────────────────────────────────────

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

function mockReader(messages: string[] = []) {
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

/** Build an async generator of StreamChunk from token strings. */
function makeStreamChunks(tokens: string[]) {
  let index = 0
  return {
    async next() {
      if (index >= tokens.length) return { done: true, value: undefined }
      const token = tokens[index++]
      return {
        done: false,
        value: { id: `chunk-${index}`, delta: token, finishReason: index >= tokens.length ? 'stop' : null },
      }
    },
    [Symbol.asyncIterator]() { return this },
    async return(value?: any) { return { done: true, value } },
    async throw(e?: unknown) { throw e },
  }
}

/** Build an async generator that throws after N tokens. */
function makeFailingStream(tokensBeforeError: string[], error: Error) {
  let index = 0
  return {
    async next() {
      if (index >= tokensBeforeError.length) throw error
      const token = tokensBeforeError[index++]
      return {
        done: false,
        value: { id: `chunk-${index}`, delta: token, finishReason: null },
      }
    },
    [Symbol.asyncIterator]() { return this },
    async return(value?: any) { return { done: true, value } },
    async throw(e?: unknown) { throw e },
  }
}

/** Build a full mock iii SDK with controllable deps. */
function buildFullMock(overrides: {
  resolveModel?: (model: string) => Promise<any>
  getKey?: (providerId: string) => Promise<string | null>
  callProvider?: (...args: any[]) => Promise<any>
  brainClassify?: (payload: any) => Promise<any>
  brainFails?: boolean
  channelReaderMessages?: string[]
} = {}) {
  const triggerCalls: { function_id: string; payload: unknown }[] = []

  const iii: any = {
    trigger: async (opts: { function_id: string; payload: unknown }) => {
      triggerCalls.push(opts)

      if (opts.function_id === 'brain::classify') {
        if (overrides.brainFails) throw new Error('brain offline')
        return overrides.brainClassify
          ? await overrides.brainClassify(opts.payload)
          : { classification: 'SIMPLE', confidence: 0.9 }
      }
      if (opts.function_id === 'translator::resolve') {
        if (overrides.resolveModel) return overrides.resolveModel((opts.payload as any).model)
        return { model: (opts.payload as any).model, providers: ['groq/gpt-4'], resolved: true }
      }
      if (opts.function_id === 'vault::retrieve') {
        if (overrides.getKey) {
          const key = await overrides.getKey((opts.payload as any).providerId)
          return { key }
        }
        return { key: 'sk-test' }
      }
      return {}
    },
    createChannel: async () => ({
      writer: { sendMessage() {}, close() {} },
      reader: overrides.channelReaderMessages
        ? mockReader(overrides.channelReaderMessages)
        : mockReader([]),
      writerRef: { channel_id: 'ch', access_key: 'k', direction: 'write' as const },
      readerRef: { channel_id: 'ch', access_key: 'k', direction: 'read' as const },
    }),
    registerFunction: () => ({ id: 'f', unregister() {} }),
    registerTrigger: () => ({ unregister() {} }),
    registerTriggerType: () => ({ id: 't', unregister() {} }),
    unregisterTriggerType: () => {},
    createStream: () => {},
    shutdown: async () => {},
    _triggerCalls: triggerCalls,
    _callProvider: overrides.callProvider,
  }

  return iii
}

// ── Happy Path: Streaming Pipeline ─────────────────────────────────────

describe('E2E: streaming happy path', () => {
  it('full streaming pipeline: request → brain → translator → vault → provider → SSE', async () => {
    const iii = buildFullMock({
      callProvider: async () => makeStreamChunks(['Hello', ' world', '!']),
      channelReaderMessages: [
        'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
        'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
        'data: {"id":"c3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}',
      ],
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    // Verify SSE headers
    const headers = inv._headers()
    assert.equal(headers['content-type'], 'text/event-stream')
    assert.equal(headers['cache-control'], 'no-cache')
    assert.equal(headers['connection'], 'keep-alive')
    assert.equal(inv._statusCode(), 200)

    // Verify all three deps were called
    const classifyCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'brain::classify')
    const resolveCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'translator::resolve')
    const vaultCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'vault::retrieve')
    assert.equal(classifyCalls.length, 1, 'brain::classify called once')
    assert.equal(resolveCalls.length, 1, 'translator::resolve called once')
    assert.ok(vaultCalls.length >= 1, 'vault::retrieve called at least once')

    // Verify SSE output written
    const hasDone = inv._written.some(w => w.includes('[DONE]'))
    assert.ok(hasDone, 'should write [DONE] sentinel')
  })

  it('full non-streaming pipeline: request → brain → translator → vault → provider → JSON', async () => {
    const iii = buildFullMock({
      callProvider: async (_config: any, _key: any, _model: any, _messages: any, options: any) => {
        if (options?.stream) {
          return makeStreamChunks(['Hi there'])
        }
        return { id: 'resp-1', content: 'Hi there', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } }
      },
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    assert.equal(inv._statusCode(), 200)
    const headers = inv._headers()
    assert.equal(headers['content-type'], 'application/json')

    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.ok(body.id?.startsWith('chatcmpl-'), 'should have chatcmpl id')
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.role, 'assistant')
    assert.equal(body.choices[0].message.content, 'Hi there')

    // Verify full dep chain was called
    const classifyCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'brain::classify')
    const resolveCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'translator::resolve')
    assert.equal(classifyCalls.length, 1, 'brain::classify called once')
    assert.equal(resolveCalls.length, 1, 'translator::resolve called once')
  })
})

// ── Failover Tests ─────────────────────────────────────────────────────

describe('E2E: failover', () => {
  it('first provider 429 → second provider succeeds → response from second', async () => {
    let callCount = 0
    const { ProviderError } = await import('./provider-client.ts')

    const iii = buildFullMock({
      resolveModel: async (model: string) => ({
        model,
        providers: ['groq/gpt-4', 'cerebras/gpt-4'],
        resolved: true,
      }),
      getKey: async (providerId: string) => `sk-${providerId}`,
      callProvider: async (config: any, _key: any, _model: any, _messages: any, _options: any) => {
        callCount++
        if (callCount === 1) throw new ProviderError(429, 'rate limited', config.baseUrl)
        return { id: 'resp-2', content: 'fallback response', finishReason: 'stop' }
      },
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    assert.equal(inv._statusCode(), 200)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.equal(body.choices[0].message.content, 'fallback response')
    assert.equal(callCount, 2, 'should have tried 2 providers')
  })

  it('all providers fail → 500/502 error with failure details', async () => {
    const { ProviderError } = await import('./provider-client.ts')

    const iii = buildFullMock({
      resolveModel: async (model: string) => ({
        model,
        providers: ['groq/gpt-4', 'cerebras/gpt-4'],
        resolved: true,
      }),
      getKey: async (providerId: string) => `sk-${providerId}`,
      callProvider: async (config: any) => {
        throw new ProviderError(500, 'internal error', config.baseUrl)
      },
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    assert.ok([500, 502].includes(inv._statusCode()), `should be 500 or 502, got ${inv._statusCode()}`)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.ok(body.error, 'should have error object')
  })

  it('streaming failover: first provider 429 → second provider streams successfully', async () => {
    let callCount = 0
    const { ProviderError } = await import('./provider-client.ts')

    const iii = buildFullMock({
      resolveModel: async (model: string) => ({
        model,
        providers: ['groq/gpt-4', 'cerebras/gpt-4'],
        resolved: true,
      }),
      getKey: async (providerId: string) => `sk-${providerId}`,
      callProvider: async (config: any, _key: any, _model: any, _messages: any, _options: any) => {
        callCount++
        if (callCount === 1) throw new ProviderError(429, 'rate limited', config.baseUrl)
        return makeStreamChunks(['recovered', ' content'])
      },
      channelReaderMessages: [
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":null}]}',
        'data: {"id":"c2","choices":[{"index":0,"delta":{"content":" content"},"finish_reason":"stop"}]}',
      ],
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    assert.equal(inv._statusCode(), 200)
    const hasDone = inv._written.some(w => w.includes('[DONE]'))
    assert.ok(hasDone, 'should stream [DONE] from second provider')
  })
})

// ── Brain Integration ──────────────────────────────────────────────────

describe('E2E: brain integration', () => {
  it('brain::classify called with correct model and messages', async () => {
    let classifyPayload: any = null

    const iii = buildFullMock({
      brainClassify: async (payload: any) => {
        classifyPayload = payload
        return { classification: 'COMPLEX', confidence: 0.85 }
      },
      callProvider: async () => ({ id: 'r', content: 'ok', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'llama3-70b',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Explain quantum computing' },
      ],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    assert.ok(classifyPayload, 'brain should have been called')
    assert.equal(classifyPayload.model, 'llama3-70b')
    assert.equal(classifyPayload.messages.length, 2)
    assert.equal(classifyPayload.messages[0].role, 'system')
    assert.equal(classifyPayload.messages[1].content, 'Explain quantum computing')
  })

  it('brain::classify failure logged but does not affect routing', async () => {
    const iii = buildFullMock({
      brainFails: true,
      callProvider: async () => ({ id: 'r', content: 'response ok', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    // Request should succeed despite brain failure
    assert.equal(inv._statusCode(), 200)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.equal(body.choices[0].message.content, 'response ok')

    // Brain error should not leak to client
    const allWritten = inv._written.join('')
    assert.ok(!allWritten.includes('brain offline'), 'brain error should not leak to response')
  })
})

// ── Edge Cases ─────────────────────────────────────────────────────────

describe('E2E: edge cases', () => {
  it('unknown model passes through to provider (translator returns resolved:false)', async () => {
    const iii = buildFullMock({
      resolveModel: async (model: string) => ({
        model,
        providers: ['groq/custom-model'],
        resolved: false,
      }),
      callProvider: async () => ({ id: 'r', content: 'custom model response', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'custom-model-v2',
      messages: [{ role: 'user', content: 'test' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    // Should still route successfully even though translator couldn't resolve
    assert.equal(inv._statusCode(), 200)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.equal(body.choices[0].message.content, 'custom model response')
  })

  it('very long message array handled correctly', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}: ${'x'.repeat(200)}`,
    }))
    messages.push({ role: 'user', content: 'Final question' })

    let receivedMessages: any[] = []

    const iii = buildFullMock({
      callProvider: async (_config: any, _key: any, _model: any, msgs: any) => {
        receivedMessages = msgs
        return { id: 'r', content: 'handled', finishReason: 'stop' }
      },
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages,
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    assert.equal(inv._statusCode(), 200)
    assert.equal(receivedMessages.length, 51, 'all 51 messages should be passed to provider')
    assert.equal(receivedMessages[50].content, 'Final question')
  })

  it('telemetry trigger calls include all routing stages', async () => {
    const iii = buildFullMock({
      callProvider: async () => ({ id: 'r', content: 'ok', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    const functionIds = iii._triggerCalls.map((c: any) => c.function_id)
    assert.ok(functionIds.includes('brain::classify'), 'brain::classify triggered')
    assert.ok(functionIds.includes('translator::resolve'), 'translator::resolve triggered')
    assert.ok(functionIds.includes('vault::retrieve'), 'vault::retrieve triggered')

    // Verify ordering: brain can be fire-and-forget, but translator must come before vault
    const translatorIdx = functionIds.indexOf('translator::resolve')
    const vaultIdx = functionIds.indexOf('vault::retrieve')
    assert.ok(translatorIdx < vaultIdx, 'translator::resolve before vault::retrieve')
  })
})
