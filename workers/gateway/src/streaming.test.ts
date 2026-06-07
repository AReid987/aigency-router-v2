import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeLlm, type RouteLlmDeps, type StreamingRouteResult } from './index.ts'
import type { StreamChunk, ProviderResponse, ProviderConfig, Message } from './provider-client.ts'

// ── Helpers ────────────────────────────────────────────────────────────

function mockDeps(overrides: Partial<RouteLlmDeps> = {}): RouteLlmDeps {
  return {
    resolveModel: overrides.resolveModel ?? (async (model: string) => ({
      model,
      providers: ['groq/llama3-8b-8192'],
      resolved: true,
    })),
    getKey: overrides.getKey ?? (async () => 'test-api-key'),
    createChannel: overrides.createChannel ?? undefined,
    callProvider: overrides.callProvider ?? undefined,
  }
}

function makeStreamChunks(tokens: string[]): AsyncGenerator<StreamChunk> {
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
    async return(value?: StreamChunk) { return { done: true, value } },
    async throw(e?: unknown) { throw e },
  }
}

function makeMockCreateChannel() {
  const sentMessages: string[] = []
  let closed = false
  const channel = {
    writer: {
      sendMessage(msg: string) { sentMessages.push(msg) },
      close() { closed = true },
    },
    writerRef: { channel_id: 'test-channel-123', access_key: 'key-abc', direction: 'write' as const },
    reader: {} as any,
    readerRef: { channel_id: 'test-channel-123', access_key: 'key-abc', direction: 'read' as const },
  }
  return { channel, sentMessages, get closed() { return closed } }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('streaming integration via iii Channels', () => {
  it('streaming request returns channel ref and streams tokens', async () => {
    const mockChannel = makeMockCreateChannel()
    const tokens = ['Hello', ' from', ' AI']

    const deps = mockDeps({
      createChannel: async () => mockChannel.channel,
      callProvider: async () => makeStreamChunks(tokens),
    })

    const result = await routeLlm(
      { model: 'llama3', messages: [{ role: 'user', content: 'hello' }], stream: true },
      deps,
    ) as StreamingRouteResult

    assert.equal(result.stream, true)
    assert.equal(result.channelRef.channel_id, 'test-channel-123')
    assert.equal(result.channelRef.direction, 'write')
    assert.ok(result.reader, 'should include reader in streaming result')
    assert.equal(result.provider, 'groq')

    // Wait for async pipeStreamToChannel to complete
    await new Promise(r => setTimeout(r, 50))

    // Should have 3 SSE data chunks + [DONE] sentinel
    assert.equal(mockChannel.sentMessages.length, 4)
    assert.ok(mockChannel.sentMessages[0].startsWith('data: '))
    assert.ok(mockChannel.sentMessages[0].includes('"content":"Hello"'))
    assert.ok(mockChannel.sentMessages[1].includes('"content":" from"'))
    assert.ok(mockChannel.sentMessages[2].includes('"content":" AI"'))
    assert.equal(mockChannel.sentMessages[3], 'data: [DONE]')
    assert.equal(mockChannel.closed, true)
  })

  it('non-streaming response returns full content (no channel)', async () => {
    const deps = mockDeps({
      callProvider: async () => ({
        id: 'resp-1',
        content: 'Hello from AI',
        finishReason: 'stop',
      } as ProviderResponse),
    })

    const result = await routeLlm(
      { model: 'llama3', messages: [{ role: 'user', content: 'hello' }] },
      deps,
    )

    assert.equal((result as any).stream, undefined)
    assert.equal((result as any).success, true)
    assert.equal((result as any).provider, 'groq')
  })

  it('provider drops mid-stream sends error chunk and closes channel', async () => {
    const mockChannel = makeMockCreateChannel()

    // Generator that throws after 2 tokens
    function makeFailingStream(): AsyncGenerator<StreamChunk> {
      let index = 0
      return {
        async next() {
          if (index >= 2) throw new Error('connection reset')
          const current = index++
          return {
            done: false,
            value: { id: `chunk-${current}`, delta: `token-${current}`, finishReason: null },
          }
        },
        [Symbol.asyncIterator]() { return this },
        async return(value?: StreamChunk) { return { done: true, value } },
        async throw(e?: unknown) { throw e },
      }
    }

    const deps = mockDeps({
      createChannel: async () => mockChannel.channel,
      callProvider: async () => makeFailingStream(),
    })

    const result = await routeLlm(
      { model: 'llama3', messages: [{ role: 'user', content: 'hello' }], stream: true },
      deps,
    ) as StreamingRouteResult

    assert.equal(result.stream, true)

    // Wait for async pipe to complete
    await new Promise(r => setTimeout(r, 50))

    // Should have: token-0, token-1, error chunk, [DONE]
    assert.ok(mockChannel.sentMessages.length >= 3)
    const errorChunk = mockChannel.sentMessages.find(m => m.includes('stream interrupted'))
    assert.ok(errorChunk, 'should send error chunk on stream failure')
    assert.equal(mockChannel.sentMessages[mockChannel.sentMessages.length - 1], 'data: [DONE]')
    assert.equal(mockChannel.closed, true)
  })

  it('[DONE] sentinel is sent at end of stream', async () => {
    const mockChannel = makeMockCreateChannel()
    const tokens = ['only-token']

    const deps = mockDeps({
      createChannel: async () => mockChannel.channel,
      callProvider: async () => makeStreamChunks(tokens),
    })

    await routeLlm(
      { model: 'llama3', messages: [{ role: 'user', content: 'test' }], stream: true },
      deps,
    ) as StreamingRouteResult

    await new Promise(r => setTimeout(r, 50))

    const lastMessage = mockChannel.sentMessages[mockChannel.sentMessages.length - 1]
    assert.equal(lastMessage, 'data: [DONE]')
  })

  it('SSE chunks contain OpenAI-compatible format', async () => {
    const mockChannel = makeMockCreateChannel()
    const tokens = ['test']

    const deps = mockDeps({
      createChannel: async () => mockChannel.channel,
      callProvider: async () => makeStreamChunks(tokens),
    })

    await routeLlm(
      { model: 'llama3', messages: [{ role: 'user', content: 'test' }], stream: true },
      deps,
    ) as StreamingRouteResult

    await new Promise(r => setTimeout(r, 50))

    // Parse the first SSE chunk
    const sseLine = mockChannel.sentMessages[0]
    assert.ok(sseLine.startsWith('data: '))
    const json = JSON.parse(sseLine.slice(6))
    assert.ok(json.id, 'should have id field')
    assert.equal(json.object, 'chat.completion.chunk')
    assert.ok(Array.isArray(json.choices), 'should have choices array')
    assert.equal(json.choices[0].index, 0)
    assert.equal(json.choices[0].delta.content, 'test')
  })

  it('streaming failover: first provider fails, second succeeds', async () => {
    const mockChannel = makeMockCreateChannel()
    const tokens = ['recovered']

    let callCount = 0
    const deps = mockDeps({
      resolveModel: async (model) => ({
        model,
        providers: ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        resolved: true,
      }),
      getKey: async (providerId) => `${providerId}-key`,
      createChannel: async () => mockChannel.channel,
      callProvider: async (config: ProviderConfig, apiKey: string, model: string, messages: Message[], options?: any) => {
        callCount++
        if (callCount === 1) {
          // First provider returns 429
          const { ProviderError } = await import('./provider-client.ts')
          throw new ProviderError(429, 'rate limited', config.baseUrl)
        }
        return makeStreamChunks(tokens)
      },
    })

    const result = await routeLlm(
      { model: 'llama3', messages: [{ role: 'user', content: 'test' }], stream: true },
      deps,
    ) as StreamingRouteResult

    assert.equal(result.stream, true)
    assert.equal(result.provider, 'cerebras')
  })

  it('streaming: no keys available returns failure', async () => {
    const deps = mockDeps({
      getKey: async () => null,
      createChannel: async () => ({}) as any,
    })

    const result = await routeLlm(
      { model: 'llama3', messages: [{ role: 'user', content: 'test' }], stream: true },
      deps,
    )

    assert.equal((result as any).success, false)
    assert.ok((result as any).failures.length > 0)
    assert.equal((result as any).failures[0].reason, 'no API key available')
  })

  it('streaming: empty provider array returns error', async () => {
    const deps = mockDeps({
      resolveModel: async (model) => ({
        model,
        providers: [],
        resolved: false,
      }),
      createChannel: async () => ({}) as any,
    })

    const result = await routeLlm(
      { model: 'unknown-model', messages: [{ role: 'user', content: 'test' }], stream: true },
      deps,
    )

    assert.equal((result as any).success, false)
    assert.ok((result as any).message.includes('No providers found'))
  })

  it('streaming without createChannel falls back to non-streaming', async () => {
    const deps = mockDeps({
      callProvider: async () => ({
        id: 'resp-1',
        content: 'fallback response',
        finishReason: 'stop',
      } as ProviderResponse),
      // no createChannel
    })

    const result = await routeLlm(
      { model: 'llama3', messages: [{ role: 'user', content: 'test' }], stream: true },
      deps,
    )

    // Should fall through to non-streaming path
    assert.equal((result as any).success, true)
    assert.equal((result as any).stream, undefined)
  })

  it('streaming: structured logs include streaming_started and streaming_ended', async () => {
    const mockChannel = makeMockCreateChannel()
    const logs: Record<string, unknown>[] = []
    const origLog = console.log
    console.log = (msg: string) => {
      try { logs.push(JSON.parse(msg)) } catch { /* skip non-JSON */ }
    }

    try {
      const deps = mockDeps({
        createChannel: async () => mockChannel.channel,
        callProvider: async () => makeStreamChunks(['hello']),
      })

      await routeLlm(
        { model: 'llama3', messages: [{ role: 'user', content: 'test' }], stream: true },
        deps,
      ) as StreamingRouteResult

      await new Promise(r => setTimeout(r, 50))

      const streamingStarted = logs.find(l => l.event === 'streaming_started')
      assert.ok(streamingStarted, 'should log streaming_started')
      assert.equal(streamingStarted.model, 'llama3')
      assert.equal(streamingStarted.provider, 'groq')

      const streamingEnded = logs.find(l => l.event === 'streaming_ended')
      assert.ok(streamingEnded, 'should log streaming_ended')
    } finally {
      console.log = origLog
    }
  })
})
