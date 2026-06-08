import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Mock the ollama module before importing factory — provides both list() and chat()
const mockList = mock.fn()
const mockChat = mock.fn()

mock.module('ollama', {
  namedExports: {
    Ollama: class MockOllama {
      list = mockList
      chat = mockChat
    },
  },
  defaultExport: class MockOllama {
    list = mockList
    chat = mockChat
  },
})

const { createSelectorAsync } = await import('./selector-factory.ts')
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
    mockList.mock.resetCalls()
    mockChat.mock.resetCalls()
  })

  it('returns SLMSelector when Ollama is reachable and model exists', async () => {
    mockList.mock.mockImplementation(async () => ({
      models: [{ name: 'qwen2.5:0.5b' }],
    }))

    const selector = await createSelectorAsync({ timeoutMs: 1000 })
    assert.ok(selector instanceof SLMSelector, 'Expected SLMSelector instance')
  })

  it('returns HeuristicSelector when Ollama is unreachable', async () => {
    mockList.mock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:11434')
    })

    const selector = await createSelectorAsync({ timeoutMs: 1000 })
    assert.ok(selector instanceof HeuristicSelector, 'Expected HeuristicSelector instance')
  })

  it('returns HeuristicSelector when Ollama is reachable but model not found', async () => {
    mockList.mock.mockImplementation(async () => ({
      models: [{ name: 'llama3:8b' }, { name: 'mistral:7b' }],
    }))

    const selector = await createSelectorAsync({ slmModel: 'qwen2.5:0.5b', timeoutMs: 1000 })
    assert.ok(selector instanceof HeuristicSelector, 'Expected HeuristicSelector when model not in list')
  })

  it('returns HeuristicSelector when preferSlm is false (skips probe)', async () => {
    const selector = await createSelectorAsync({ preferSlm: false })
    assert.ok(selector instanceof HeuristicSelector, 'Expected HeuristicSelector when preferSlm=false')
    assert.equal(mockList.mock.callCount(), 0, 'Should not probe Ollama when preferSlm=false')
  })

  it('returned selector has working classify() method', async () => {
    mockList.mock.mockImplementation(async () => ({
      models: [{ name: 'qwen2.5:0.5b' }],
    }))
    mockChat.mock.mockImplementation(async () => ({
      message: { content: '{"classification": "simple", "reason": "test"}' },
    }))

    const selector = await createSelectorAsync({ timeoutMs: 1000 })

    // SLMSelector.classify() is async — returns a Promise
    const result = selector.classify(makeRequest())
    assert.ok(result instanceof Promise, 'SLMSelector.classify() should return a Promise')
    assert.equal(await result, 'simple', 'classify() should resolve to a classification')
  })
})
