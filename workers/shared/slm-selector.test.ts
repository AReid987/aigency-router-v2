import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Mock the llama-client module before importing SLMSelector
const mockClassifyViaLlama = mock.fn()
const mockGetDefaultModelPath = mock.fn(() => '/mock/models/qwen2.5-0.5b-instruct-q4_k_m.gguf')
const mockIsLlamaBinaryAvailable = mock.fn(() => true)
const mockIsModelAvailable = mock.fn(() => true)

mock.module('./llama-client.ts', {
  namedExports: {
    classifyViaLlama: mockClassifyViaLlama,
    getDefaultModelPath: mockGetDefaultModelPath,
    isLlamaBinaryAvailable: mockIsLlamaBinaryAvailable,
    isModelAvailable: mockIsModelAvailable,
  },
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
    mockClassifyViaLlama.mock.resetCalls()
    mockGetDefaultModelPath.mock.resetCalls()
    mockIsLlamaBinaryAvailable.mock.resetCalls()
    mockIsModelAvailable.mock.resetCalls()
    telemetryCalls = []
    mockTrigger = async (_target: string, _fnName: string, input: unknown) => {
      telemetryCalls.push(input as Record<string, unknown>)
      return {}
    }
  })

  it('classifies a simple request correctly', async () => {
    mockClassifyViaLlama.mock.mockImplementation(async () =>
      '{"classification": "simple", "reason": "short prompt"}',
    )

    const selector = new SLMSelector({
      telemetryDeps: { trigger: mockTrigger },
      timeoutMs: 1000,
    })

    const result = await selector.classify(makeRequest())
    assert.equal(result, 'simple')
  })

  it('classifies a complex request (5 messages, enforce_json)', async () => {
    mockClassifyViaLlama.mock.mockImplementation(async () =>
      '{"classification": "complex", "reason": "multi-turn with JSON"}',
    )

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

  it('throws timeout error when llama-cli is too slow', async () => {
    mockClassifyViaLlama.mock.mockImplementation(async () => {
      throw new Error('llama-cli timeout after 50ms')
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
    mockClassifyViaLlama.mock.mockImplementation(async () => {
      throw new Error('No valid classification JSON found in output: not json at all')
    })

    const selector = new SLMSelector({ timeoutMs: 1000 })

    await assert.rejects(
      () => selector.classify(makeRequest()),
      (err: Error) => {
        // The error propagates from llama-client's extractClassificationJson
        assert.match(err.message, /No valid classification JSON/i)
        return true
      },
    )
  })

  it('throws ENOENT error when llama-cli binary is not found', async () => {
    mockClassifyViaLlama.mock.mockImplementation(async () => {
      throw new Error('llama-cli binary not found: llama-cli')
    })

    const selector = new SLMSelector({ timeoutMs: 1000 })

    await assert.rejects(
      () => selector.classify(makeRequest()),
      (err: Error) => {
        assert.match(err.message, /not found/i)
        return true
      },
    )
  })

  it('emits SLM_CLASSIFY telemetry on successful classification', async () => {
    mockClassifyViaLlama.mock.mockImplementation(async () =>
      '{"classification": "simple", "reason": "test"}',
    )

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
    assert.equal(event.payload.model, 'qwen2.5-0.5b-instruct-q4_k_m')
    assert.equal(event.payload.requestMessageCount, 1)
    assert.ok(typeof event.payload.latencyMs === 'number')
  })

  it('isAvailable returns true when binary and model exist', () => {
    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => true)
    mockIsModelAvailable.mock.mockImplementation(() => true)

    const selector = new SLMSelector()
    assert.equal(selector.isAvailable(), true)
  })

  it('isAvailable returns false when binary is missing', () => {
    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => false)
    mockIsModelAvailable.mock.mockImplementation(() => true)

    const selector = new SLMSelector()
    assert.equal(selector.isAvailable(), false)
  })

  it('isAvailable returns false when model is missing', () => {
    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => true)
    mockIsModelAvailable.mock.mockImplementation(() => false)

    const selector = new SLMSelector()
    assert.equal(selector.isAvailable(), false)
  })
})
