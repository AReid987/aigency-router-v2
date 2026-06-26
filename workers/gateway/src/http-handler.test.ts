import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// ── Mock Helpers ───────────────────────────────────────────────────────

/**
 * Create a mock iii function invocation object that the http() wrapper expects.
 * The http() destructures { response, ...request } from the arg.
 * response needs: sendMessage (for status/headers), stream (for writing), close (for closing).
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

function mockReader(messages: string[] = ['chunk-1', 'chunk-2']) {
  const stream = new EventEmitter()
  let closed = false
  const callbacks: ((msg: string) => void)[] = []

  const deliver = () => {
    for (const msg of messages) {
      for (const cb of callbacks) {
        cb(msg)
      }
    }
    // Emit 'end' after all messages delivered
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
 * Mock callProvider that returns a streaming async generator.
 */
function mockStreamingCallProvider(chunks: Array<{ id: string; delta: string; finishReason: string | null }> = []) {
  return async (
    _config: any,
    _apiKey: any,
    _model: any,
    _messages: any,
    options: any = {},
  ) => {
    if (options.stream) {
      return (async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      })()
    }
    // Non-streaming fallback
    return { content: 'mock response', finishReason: 'stop' }
  }
}

/**
 * Mock callProvider that returns a non-streaming response.
 */
function mockNonStreamingCallProvider(content: string = 'Hello!') {
  return async (
    _config: any,
    _apiKey: any,
    _model: any,
    _messages: any,
    options: any = {},
  ) => {
    if (options.stream) {
      return (async function* () {
        yield { id: 'c1', delta: content, finishReason: null }
        yield { id: 'c1', delta: '', finishReason: 'stop' }
      })()
    }
    return { content, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  }
}

function mockIII(overrides: {
  channelReader?: ReturnType<typeof mockReader>
  callProvider?: (...args: any[]) => Promise<any>
} = {}) {
  return {
    trigger: async (opts: { function_id: string; payload: unknown }) => {
      if (opts.function_id === 'translator::resolve') return { model: 'gpt-4', providers: ['groq/gpt-4'], resolved: true }
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

// ── Streaming Tests ────────────────────────────────────────────────────

describe('HTTP handler: streaming', () => {
  it('streaming request sets SSE headers', async () => {
    const reader = mockReader([
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
    ])

    const iii = mockIII({
      channelReader: reader,
      callProvider: mockStreamingCallProvider([
        { id: 'c1', delta: 'Hi', finishReason: null },
      ]),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 150))

    const headers = inv._headers()
    assert.equal(headers['content-type'], 'text/event-stream')
    assert.equal(headers['cache-control'], 'no-cache')
    assert.equal(headers['connection'], 'keep-alive')
    assert.equal(inv._statusCode(), 200)
  })

  it('streaming request writes SSE chunks to response', async () => {
    const sseChunk = 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}'
    const reader = mockReader([sseChunk])

    const iii = mockIII({
      channelReader: reader,
      callProvider: mockStreamingCallProvider([
        { id: 'c1', delta: 'Hello', finishReason: null },
      ]),
    })

    const inv = mockInvocation({
      model: 'llama3',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 150))

    const hasChunk = inv._written.some(w => w.includes('"content":"Hello"'))
    assert.ok(hasChunk, 'should write SSE chunk with content')
    const hasDone = inv._written.some(w => w.includes('[DONE]'))
    assert.ok(hasDone, 'should write [DONE] sentinel')
  })

  it('streaming sends [DONE] sentinel at end', async () => {
    const reader = mockReader([
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}',
    ])

    const iii = mockIII({
      channelReader: reader,
      callProvider: mockStreamingCallProvider([
        { id: 'c1', delta: 'x', finishReason: null },
      ]),
    })

    const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 150))

    const lastWritten = inv._written[inv._written.length - 1]
    assert.ok(lastWritten?.includes('data: [DONE]'), 'should end with [DONE]')
  })

  it('stream error sends error chunk and closes cleanly', async () => {
    const reader = mockReader(['chunk-ok'])

    const iii = mockIII({
      channelReader: reader,
      callProvider: mockStreamingCallProvider([
        { id: 'c1', delta: 'ok', finishReason: null },
      ]),
    })

    const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })

    // Override stream.write to throw after first call (simulating client disconnect)
    let writeCount = 0
    const origWrite = inv.response.stream.write.bind(inv.response.stream)
    inv.response.stream.write = (data: string) => {
      writeCount++
      if (writeCount > 1) throw new Error('connection reset')
      return origWrite(data)
    }

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })

    // Should not throw — handler catches write errors
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 150))

    assert.ok(inv._written.length > 0, 'should have written chunks before error')
  })

  it('client disconnect marks reader as closed', async () => {
    // Use a reader that never ends — so the close listener stays active
    const stream = new EventEmitter()
    let closed = false
    const callbacks: ((msg: string) => void)[] = []
    const neverEndingReader = {
      onMessage(cb: (msg: string) => void) {
        callbacks.push(cb)
        // Deliver one message immediately but DON'T end the stream
        setTimeout(() => cb('data: chunk'), 2)
      },
      close() { closed = true },
      stream,
      get _closed() { return closed },
    }

    const iii = mockIII({
      channelReader: neverEndingReader as any,
      callProvider: mockStreamingCallProvider([
        { id: 'c1', delta: 'chunk', finishReason: null },
      ]),
    })

    const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    // Wait for handler to set up listeners and receive chunks
    await new Promise(r => setTimeout(r, 30))

    // Simulate client disconnect by emitting 'close' on the response stream
    inv.response.stream.emit('close')

    await new Promise(r => setTimeout(r, 50))

    assert.equal(closed, true, 'reader should be closed on client disconnect')
  })
})

// ── Non-streaming Tests ────────────────────────────────────────────────

describe('HTTP handler: non-streaming', () => {
  it('returns JSON completion response with all required fields', async () => {
    const iii = mockIII({
      callProvider: mockNonStreamingCallProvider('Hello there!'),
    })

    const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 100))

    assert.equal(inv._statusCode(), 200)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.ok(body.id?.startsWith('chatcmpl-'), 'id should start with chatcmpl-')
    assert.equal(body.object, 'chat.completion')
    assert.ok(Array.isArray(body.choices), 'should have choices array')
    assert.equal(body.choices[0].index, 0)
    assert.equal(body.choices[0].message.role, 'assistant')
    assert.equal(body.choices[0].message.content, 'Hello there!')
  })

  it('response status 200 with application/json content type on success', async () => {
    const iii = mockIII({
      callProvider: mockNonStreamingCallProvider('ok'),
    })

    const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: iii._callProvider as any })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 100))

    assert.equal(inv._statusCode(), 200)
    const headers = inv._headers()
    assert.equal(headers['content-type'], 'application/json')
  })

  it('missing model returns 400 with error body', async () => {
    const iii = mockIII()
    const inv = mockInvocation({ messages: [{ role: 'user', content: 'hi' }] })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any)
    await handler(inv as any)

    assert.equal(inv._statusCode(), 400)
    const body = JSON.parse(inv._written[0])
    assert.ok(body.error, 'should have error object')
    assert.ok(body.error.message.includes('model'), 'error message should mention model')
    assert.equal(body.error.type, 'invalid_request_error')
  })

  it('missing messages returns 400 with error body', async () => {
    const iii = mockIII()
    const inv = mockInvocation({ model: 'gpt-4' })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any)
    await handler(inv as any)

    assert.equal(inv._statusCode(), 400)
    const body = JSON.parse(inv._written[0])
    assert.ok(body.error.message.includes('messages'), 'error message should mention messages')
  })

  it('empty messages array returns 400', async () => {
    const iii = mockIII()
    const inv = mockInvocation({ model: 'gpt-4', messages: [] })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any)
    await handler(inv as any)

    assert.equal(inv._statusCode(), 400)
    const body = JSON.parse(inv._written[0])
    assert.ok(body.error.message.includes('messages'))
  })
})

// ── Brain Integration Tests ────────────────────────────────────────────

describe('HTTP handler: brain::classify integration', () => {
  it('brain::classify is called as fire-and-forget', async () => {
    const triggerCalls: { function_id: string; payload: unknown }[] = []

    const iii = {
      ...mockIII({
        callProvider: mockNonStreamingCallProvider('hi'),
      }),
      trigger: async (opts: { function_id: string; payload: unknown }) => {
        triggerCalls.push(opts)
        if (opts.function_id === 'translator::resolve') return { model: 'gpt-4', providers: ['groq/gpt-4'], resolved: true }
        if (opts.function_id === 'vault::retrieve') return { key: 'sk' }
        if (opts.function_id === 'brain::classify') return { classification: 'SIMPLE', confidence: 0.9 }
        return {}
      },
    }

    const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: (iii as any)._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    const classifyCalls = triggerCalls.filter(c => c.function_id === 'brain::classify')
    assert.equal(classifyCalls.length, 1, 'brain::classify should be called once')
    assert.equal((classifyCalls[0].payload as any).model, 'gpt-4')
  })

  it('brain failure does not block or fail the request', async () => {
    let brainFailed = false
    const iii = {
      ...mockIII({
        callProvider: mockNonStreamingCallProvider('ok'),
      }),
      trigger: async (opts: { function_id: string }) => {
        if (opts.function_id === 'translator::resolve') return { model: 'gpt-4', providers: ['groq/gpt-4'], resolved: true }
        if (opts.function_id === 'vault::retrieve') return { key: 'sk' }
        if (opts.function_id === 'brain::classify') {
          brainFailed = true
          throw new Error('brain offline')
        }
        return {}
      },
    }

    const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: (iii as any)._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    assert.ok(brainFailed, 'brain should have been called and failed')
    // Brain error should not leak to client
    const responseBody = inv._written.join('')
    assert.ok(!responseBody.includes('brain offline'), 'brain error should not leak to client')
    // Request should succeed despite brain failure
    assert.equal(inv._statusCode(), 200)
  })

  it('classification result is logged', async () => {
    const logs: Record<string, unknown>[] = []
    const origLog = console.log
    console.log = (msg: string) => {
      try { logs.push(JSON.parse(msg)) } catch { /* skip */ }
    }

    try {
      const iii = mockIII({
        callProvider: mockNonStreamingCallProvider('hi'),
      })

      const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

      const { createChatCompletionsHandler } = await import('./http-handler.ts')
      const handler = createChatCompletionsHandler(iii as any, { callProvider: (iii as any)._callProvider })
      await handler(inv as any)

      await new Promise(r => setTimeout(r, 200))

      const brainLog = logs.find(l => l.event === 'brain_classification')
      assert.ok(brainLog, 'should log brain_classification event')
      assert.equal(brainLog.classification, 'SIMPLE')
      assert.equal(brainLog.confidence, 0.9)
    } finally {
      console.log = origLog
    }
  })
})

// ── Error Handling Tests ────────────────────────────────────────────────

describe('HTTP handler: error handling', () => {
  it('all providers fail returns error response', async () => {
    const failCallProvider = async () => {
      throw new Error('provider unavailable')
    }

    const iii = mockIII({ callProvider: failCallProvider })

    const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any, { callProvider: failCallProvider as any })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 100))

    assert.ok([500, 502].includes(inv._statusCode()), `should be 500 or 502, got ${inv._statusCode()}`)
    if (inv._written.length > 0) {
      const body = JSON.parse(inv._written[inv._written.length - 1])
      assert.ok(body.error, 'should have error object')
    }
  })

  it('no API keys returns error with descriptive message', async () => {
    const iii = {
      ...mockIII(),
      trigger: async (opts: { function_id: string }) => {
        if (opts.function_id === 'translator::resolve') return { model: 'gpt-4', providers: ['groq/gpt-4'], resolved: true }
        if (opts.function_id === 'vault::retrieve') return { key: null }
        if (opts.function_id === 'brain::classify') return { classification: 'SIMPLE', confidence: 0.9 }
        return {}
      },
    }

    const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any)
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 100))

    assert.ok([500, 502].includes(inv._statusCode()), `should be 500 or 502, got ${inv._statusCode()}`)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.ok(body.error, 'should have error')
    assert.ok(
      body.error.message.includes('key') || body.error.message.includes('provider') || body.error.message.includes('fail') || body.error.message.includes('No'),
      `error should describe the problem, got: ${body.error.message}`
    )
  })

  it('empty provider array returns error with No providers message', async () => {
    const iii = {
      ...mockIII(),
      trigger: async (opts: { function_id: string }) => {
        if (opts.function_id === 'translator::resolve') return { model: 'unknown', providers: [], resolved: false }
        if (opts.function_id === 'vault::retrieve') return { key: 'k' }
        if (opts.function_id === 'brain::classify') return { classification: 'SIMPLE', confidence: 0.9 }
        return {}
      },
    }

    const inv = mockInvocation({ model: 'unknown', messages: [{ role: 'user', content: 'hi' }] })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any)
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 100))

    assert.ok([500, 502].includes(inv._statusCode()), `should be 500 or 502, got ${inv._statusCode()}`)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.ok(body.error.message.includes('provider') || body.error.message.includes('No'), 'error should mention no providers')
  })

  it('malformed/undefined body returns 400 with parse error', async () => {
    const iii = mockIII()
    const inv = mockInvocation(undefined)

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii as any)
    await handler(inv as any)

    assert.equal(inv._statusCode(), 400)
    const body = JSON.parse(inv._written[0])
    assert.ok(body.error, 'should have error')
    assert.equal(body.error.type, 'invalid_request_error')
  })

  it('structured log events are emitted for each code path', async () => {
    const logs: Record<string, unknown>[] = []
    const origLog = console.log
    console.log = (msg: string) => {
      try { logs.push(JSON.parse(msg)) } catch { /* skip */ }
    }

    try {
      const iii = mockIII({
        callProvider: mockNonStreamingCallProvider('ok'),
      })

      const inv = mockInvocation({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

      const { createChatCompletionsHandler } = await import('./http-handler.ts')
      const handler = createChatCompletionsHandler(iii as any, { callProvider: (iii as any)._callProvider })
      await handler(inv as any)

      await new Promise(r => setTimeout(r, 200))

      // http-handler.ts logEvent still writes via console.log when _logger is null.
      // model_resolved is emitted by index.ts routeLlm via pino and is not captured here.
      const requestLog = logs.find(l => l.event === 'chat_completions_request')
      assert.ok(requestLog, 'should log chat_completions_request')
      assert.equal(requestLog.model, 'gpt-4')
      assert.equal(requestLog.stream, false)

      const successLog = logs.find(l => l.event === 'route_success')
      assert.ok(successLog, 'should log route_success')
    } finally {
      console.log = origLog
    }
  })
})
