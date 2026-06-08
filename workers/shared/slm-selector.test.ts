import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Mock the ollama module before importing SLMSelector
const mockChat = mock.fn()

mock.module('ollama', {
  namedExports: { Ollama: class MockOllama { chat = mockChat } },
  defaultExport: class MockOllama { chat = mockChat },
})

const { SLMSelector } = await import('./slm-selector.ts')

function makeRequest(overrides: Partial<{ messages: Array<{ role: string; content: string }>; enforce_json: boolean; max_tokens: number }> = {}) {
  return {
    model: 'gpt-4',
    messages: overrides.messages ?? [{ role: 'user', content: 'hello' }],
    ...(overrides.enforce_json !== undefined ? { enforce_json: overrides.enforce_json } : {}),
    ...(overrides.max_tokens !== undefined ? { max_tokens: overrides.max_tokens } : {}),
  }
}

describe('SLMSelector', () => {
  let telemetryCalls: Array<Record<string, unknown>>
  let mockTrigger: (target: string, fnName: string, input: unknown) => Promise<unknown>

  beforeEach(() => {
    mockChat.mock.resetCalls()
    telemetryCalls = []
    mockTrigger = async (_target: string, _fnName: string, input: unknown) => {
      telemetryCalls.push(input as Record<string, unknown>)
      return {}
    }
  })

  it('classifies a simple request correctly', async () => {
    mockChat.mock.mockImplementation(async () => ({
      message: { content: '{"classification": "simple", "reason": "short prompt"}' },
    }))

    const selector = new SLMSelector({
      telemetryDeps: { trigger: mockTrigger },
      timeoutMs: 1000,
    })

    const result = await selector.classify(makeRequest())
    assert.equal(result, 'simple')
  })

  it('classifies a complex request (5 messages, enforce_json)', async () => {
    mockChat.mock.mockImplementation(async () => ({
      message: { content: '{"classification": "complex", "reason": "multi-turn with JSON"}' },
    }))

    const selector = new SLMSelector({
      telemetryDeps: { trigger: mockTrigger },
      timeoutMs: 1000,
    })

    const result = await selector.classify(
      makeRequest({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
          { role: 'assistant', content: 'd' },
          { role: 'user', content: 'e' },
        ],
        enforce_json: true,
      }),
    )
    assert.equal(result, 'complex')
  })

  it('throws timeout error when Ollama is too slow', async () => {
    mockChat.mock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      return { message: { content: '{}' } }
    })

    const selector = new SLMSelector({ timeoutMs: 50 })

    await assert.rejects(
      () => selector.classify(makeRequest()),
      (err: Error) => {
        assert.match(err.message, /timeout/i)
        return true
      },
    )
  })

  it('throws parse error for malformed JSON', async () => {
    mockChat.mock.mockImplementation(async () => ({
      message: { content: 'not json at all' },
    }))

    const selector = new SLMSelector({ timeoutMs: 1000 })

    await assert.rejects(
      () => selector.classify(makeRequest()),
      (err: Error) => {
        assert.match(err.message, /malformed JSON/i)
        return true
      },
    )
  })

  it('throws connection error when Ollama is unreachable', async () => {
    mockChat.mock.mockImplementation(async () => {
      throw new Error('fetch failed ECONNREFUSED 127.0.0.1:11434')
    })

    const selector = new SLMSelector({ timeoutMs: 1000 })

    await assert.rejects(
      () => selector.classify(makeRequest()),
      (err: Error) => {
        assert.match(err.message, /connection refused/i)
        return true
      },
    )
  })

  it('emits SLM_CLASSIFY telemetry on successful classification', async () => {
    mockChat.mock.mockImplementation(async () => ({
      message: { content: '{"classification": "simple", "reason": "test"}' },
    }))

    const selector = new SLMSelector({
      telemetryDeps: { trigger: mockTrigger },
      sourceWorker: 'test-worker',
      timeoutMs: 1000,
    })

    await selector.classify(makeRequest())

    assert.equal(telemetryCalls.length, 1)
    const event = telemetryCalls[0] as {
      eventClass: string
      sourceWorker: string
      payload: Record<string, unknown>
    }
    assert.equal(event.eventClass, 'SLM_CLASSIFY')
    assert.equal(event.sourceWorker, 'test-worker')
    assert.equal(event.payload.classification, 'simple')
    assert.equal(event.payload.model, 'qwen2.5:0.5b')
    assert.equal(event.payload.requestMessageCount, 1)
    assert.ok(typeof event.payload.latencyMs === 'number')
  })
})
