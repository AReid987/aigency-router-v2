import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Mock the llama-client module before importing factory
const mockIsLlamaBinaryAvailable = mock.fn(() => true)
const mockIsModelAvailable = mock.fn(() => true)
const mockGetDefaultModelPath = mock.fn(() => '/mock/models/qwen2.5-0.5b-instruct-q4_k_m.gguf')
const mockClassifyViaLlama = mock.fn()

mock.module('./llama-client.ts', {
  namedExports: {
    isLlamaBinaryAvailable: mockIsLlamaBinaryAvailable,
    isModelAvailable: mockIsModelAvailable,
    getDefaultModelPath: mockGetDefaultModelPath,
    classifyViaLlama: mockClassifyViaLlama,
  },
})

const { createSelector, createSelectorAsync } = await import('./selector-factory.ts')
const { SLMSelector } = await import('./slm-selector.ts')
const { HeuristicSelector } = await import('../vault/src/selector.ts')

function makeRequest(overrides: Partial<{ messages: Array<{ role: string; content: string }>; enforce_json: boolean; max_tokens: number }> = {}) {
  return {
    model: 'gpt-4',
    messages: overrides.messages ?? [{ role: 'user', content: 'hello' }],
    ...(overrides.enforce_json !== undefined ? { enforce_json: overrides.enforce_json } : {}),
    ...(overrides.max_tokens !== undefined ? { max_tokens: overrides.max_tokens } : {}),
  }
}

describe('Selector Factory', () => {
  beforeEach(() => {
    mockIsLlamaBinaryAvailable.mock.resetCalls()
    mockIsModelAvailable.mock.resetCalls()
    mockGetDefaultModelPath.mock.resetCalls()
    mockClassifyViaLlama.mock.resetCalls()
  })

  it('returns SLMSelector when llama-cli binary and GGUF model exist', () => {
    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => true)
    mockIsModelAvailable.mock.mockImplementation(() => true)

    const selector = createSelector({ timeoutMs: 1000 })
    assert.ok(selector instanceof SLMSelector, 'Expected SLMSelector instance')
  })

  it('returns HeuristicSelector when llama-cli binary is missing', () => {
    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => false)
    mockIsModelAvailable.mock.mockImplementation(() => true)

    const selector = createSelector({ timeoutMs: 1000 })
    assert.ok(selector instanceof HeuristicSelector, 'Expected HeuristicSelector instance')
  })

  it('returns HeuristicSelector when GGUF model is missing', () => {
    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => true)
    mockIsModelAvailable.mock.mockImplementation(() => false)

    const selector = createSelector({ timeoutMs: 1000 })
    assert.ok(selector instanceof HeuristicSelector, 'Expected HeuristicSelector instance')
  })

  it('returns HeuristicSelector when both binary and model are missing', () => {
    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => false)
    mockIsModelAvailable.mock.mockImplementation(() => false)

    const selector = createSelector({ timeoutMs: 1000 })
    assert.ok(selector instanceof HeuristicSelector, 'Expected HeuristicSelector instance')
  })

  it('returns HeuristicSelector when preferSlm is false (skips probe)', () => {
    const selector = createSelector({ preferSlm: false })
    assert.ok(selector instanceof HeuristicSelector, 'Expected HeuristicSelector when preferSlm=false')
    assert.equal(mockIsLlamaBinaryAvailable.mock.callCount(), 0, 'Should not probe when preferSlm=false')
    assert.equal(mockIsModelAvailable.mock.callCount(), 0, 'Should not probe when preferSlm=false')
  })

  it('async factory returns same result as sync factory', async () => {
    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => true)
    mockIsModelAvailable.mock.mockImplementation(() => true)

    const syncSelector = createSelector({ timeoutMs: 1000 })
    const asyncSelector = await createSelectorAsync({ timeoutMs: 1000 })

    assert.equal(syncSelector.constructor.name, asyncSelector.constructor.name, 'Sync and async factories should return same type')
  })

  it('returned selector has working classify() method', async () => {
    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => true)
    mockIsModelAvailable.mock.mockImplementation(() => true)
    mockClassifyViaLlama.mock.mockImplementation(async () =>
      '{"classification": "simple", "reason": "test"}',
    )

    const selector = createSelector({ timeoutMs: 1000 })

    // SLMSelector.classify() is async — returns a Promise
    const result = selector.classify(makeRequest())
    assert.ok(result instanceof Promise, 'SLMSelector.classify() should return a Promise')
    assert.equal(await result, 'simple', 'classify() should resolve to a classification')
  })

  it('logs warning with model path when model not found', () => {
    const warnCalls: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnCalls.push(args) }

    mockIsLlamaBinaryAvailable.mock.mockImplementation(() => true)
    mockIsModelAvailable.mock.mockImplementation(() => false)

    createSelector({ modelPath: '/custom/path/model.gguf' })

    console.warn = originalWarn
    assert.ok(warnCalls.length > 0, 'Should log a warning')
    const warnMsg = warnCalls[0][0] as string
    assert.ok(warnMsg.includes('/custom/path/model.gguf'), 'Warning should include model path')
  })
})
