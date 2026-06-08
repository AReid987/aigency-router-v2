import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// ── Mocks ──────────────────────────────────────────────────────────────

// Track registered functions and trigger calls
const registeredFunctions = new Map<string, Function>()
const triggerCalls: Array<{ function_id: string; payload: unknown }> = []

const mockRegisterWorker = mock.fn(() => ({
  registerFunction: (name: string, fn: Function) => {
    registeredFunctions.set(name, fn)
  },
  trigger: async (args: { function_id: string; payload?: unknown }) => {
    triggerCalls.push({ function_id: args.function_id, payload: args.payload })
    return { logged: true }
  },
  shutdown: async () => {},
}))

mock.module('iii-sdk', {
  namedExports: {
    registerWorker: mockRegisterWorker,
  },
  defaultExport: {
    registerWorker: mockRegisterWorker,
  },
})

// Mock selector-factory: control which selector is returned
let factoryResult: 'slm' | 'heuristic' = 'heuristic'
const mockCreateSelectorAsync = mock.fn(async () => {
  if (factoryResult === 'slm') {
    // Return a mock SLMSelector with async classify()
    return {
      classify: mock.fn(async (_req: unknown) => 'simple'),
    }
  }
  // Return a mock HeuristicSelector with sync classify()
  return {
    classify: mock.fn((_req: unknown) => 'complex'),
  }
})

mock.module('../../shared/selector-factory.ts', {
  namedExports: {
    createSelectorAsync: mockCreateSelectorAsync,
  },
})

// Mock SLMSelector class (used for instanceof check)
class MockSLMSelector {
  classify = mock.fn(async (_req: unknown) => 'simple')
}

mock.module('../../shared/slm-selector.ts', {
  namedExports: {
    SLMSelector: MockSLMSelector,
  },
})

// Mock telemetry
mock.module('../../shared/telemetry.ts', {
  namedExports: {
    logTelemetry: mock.fn(async () => {}),
  },
})

// ── Import worker AFTER mocks ──────────────────────────────────────────

const { createSelectorWorker } = await import('./index.ts')

// ── Helpers ────────────────────────────────────────────────────────────

function makeClassifyInput(overrides: Partial<{
  model: string
  messages: Array<{ role: string; content: string }>
  enforce_json: boolean
  max_tokens: number
}> = {}) {
  return {
    model: overrides.model ?? 'gpt-4',
    messages: overrides.messages ?? [{ role: 'user', content: 'hello' }],
    ...(overrides.enforce_json !== undefined ? { enforce_json: overrides.enforce_json } : {}),
    ...(overrides.max_tokens !== undefined ? { max_tokens: overrides.max_tokens } : {}),
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Selector iii Worker', () => {
  beforeEach(() => {
    registeredFunctions.clear()
    triggerCalls.length = 0
    mockCreateSelectorAsync.mock.resetCalls()
  })

  it('classify with HeuristicSelector returns source=heuristic', async () => {
    factoryResult = 'heuristic'
    mockCreateSelectorAsync.mock.mockImplementation(async () => ({
      classify: mock.fn((_req: unknown) => 'complex'),
    }))

    const { iii, ready } = createSelectorWorker('ws://mock:49134')
    await ready

    const classifyFn = registeredFunctions.get('selector::classify')
    assert.ok(classifyFn, 'selector::classify should be registered')

    const result = await classifyFn!(makeClassifyInput())
    assert.equal(result.classification, 'complex')
    assert.equal(result.source, 'heuristic')
    assert.equal(result.model, 'gpt-4')
    assert.ok(typeof result.latencyMs === 'number')
    assert.ok(typeof result.confidence === 'number')
  })

  it('classify with SLMSelector returns source=slm', async () => {
    factoryResult = 'slm'
    mockCreateSelectorAsync.mock.mockImplementation(async () => {
      const slm = new MockSLMSelector()
      slm.classify = mock.fn(async (_req: unknown) => 'simple')
      // Return object that passes instanceof check
      return Object.assign(Object.create(MockSLMSelector.prototype), {
        classify: slm.classify,
      })
    })

    const { iii, ready } = createSelectorWorker('ws://mock:49134')
    await ready

    const classifyFn = registeredFunctions.get('selector::classify')
    assert.ok(classifyFn, 'selector::classify should be registered')

    const result = await classifyFn!(makeClassifyInput())
    assert.equal(result.classification, 'simple')
    assert.equal(result.source, 'slm')
    assert.equal(result.model, 'gpt-4')
  })

  it('status returns healthy with slmAvailable', async () => {
    factoryResult = 'heuristic'
    mockCreateSelectorAsync.mock.mockImplementation(async () => ({
      classify: mock.fn((_req: unknown) => 'complex'),
    }))

    const { iii, ready } = createSelectorWorker('ws://mock:49134')
    await ready

    const statusFn = registeredFunctions.get('selector::status')
    assert.ok(statusFn, 'selector::status should be registered')

    const result = await statusFn!()
    assert.equal(result.status, 'healthy')
    assert.equal(result.worker, 'selector')
    assert.equal(result.slmAvailable, false)
    assert.equal(typeof result.model, 'string')
  })

  it('classify payload shape matches expected format', async () => {
    factoryResult = 'heuristic'
    mockCreateSelectorAsync.mock.mockImplementation(async () => ({
      classify: mock.fn((_req: unknown) => 'simple'),
    }))

    const { iii, ready } = createSelectorWorker('ws://mock:49134')
    await ready

    const classifyFn = registeredFunctions.get('selector::classify')
    assert.ok(classifyFn, 'selector::classify should be registered')

    const result = await classifyFn!(makeClassifyInput({
      model: 'claude-3',
      messages: [{ role: 'user', content: 'test' }],
      enforce_json: true,
      max_tokens: 1024,
    }))

    // Verify all required fields exist with correct types
    assert.ok('classification' in result, 'result should have classification')
    assert.ok('confidence' in result, 'result should have confidence')
    assert.ok('source' in result, 'result should have source')
    assert.ok('model' in result, 'result should have model')
    assert.ok('latencyMs' in result, 'result should have latencyMs')

    assert.ok(
      result.classification === 'simple' || result.classification === 'complex',
      'classification should be simple or complex',
    )
    assert.ok(typeof result.confidence === 'number', 'confidence should be number')
    assert.ok(
      result.source === 'slm' || result.source === 'heuristic',
      'source should be slm or heuristic',
    )
    assert.equal(result.model, 'claude-3')
    assert.ok(typeof result.latencyMs === 'number', 'latencyMs should be number')
  })
})
