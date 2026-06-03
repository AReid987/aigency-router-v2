import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HeuristicSelector,
  createSelector,
  type Selector,
  type ModelRequest,
  type Classification,
} from './selector.ts'

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  }
}

describe('HeuristicSelector', () => {
  const selector = new HeuristicSelector()

  it('classifies a simple single-message request as simple', () => {
    const req = makeRequest()
    assert.equal(selector.classify(req), 'simple')
  })

  it('classifies 3 messages with no extras as simple', () => {
    const req = makeRequest({
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    })
    assert.equal(selector.classify(req), 'simple')
  })

  it('classifies >3 messages as complex', () => {
    const req = makeRequest({
      messages: [
        { role: 'system', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
        { role: 'user', content: 'd' },
      ],
    })
    assert.equal(selector.classify(req), 'complex')
  })

  it('classifies enforce_json=true as complex', () => {
    const req = makeRequest({ enforce_json: true })
    assert.equal(selector.classify(req), 'complex')
  })

  it('classifies high max_tokens as complex', () => {
    const req = makeRequest({ max_tokens: 8192 })
    assert.equal(selector.classify(req), 'complex')
  })

  it('classifies max_tokens <= 4096 as simple', () => {
    const req = makeRequest({ max_tokens: 4096 })
    assert.equal(selector.classify(req), 'simple')
  })

  it('handles empty messages array as simple', () => {
    const req = makeRequest({ messages: [] })
    assert.equal(selector.classify(req), 'simple')
  })

  it('handles missing optional fields as simple', () => {
    const req: ModelRequest = { model: 'x', messages: [{ role: 'user', content: 'q' }] }
    assert.equal(selector.classify(req), 'simple')
  })
})

describe('createSelector factory', () => {
  it('returns a HeuristicSelector by default', () => {
    const selector = createSelector()
    assert.ok(selector instanceof HeuristicSelector)
  })

  it('returned selector classifies correctly', () => {
    const selector = createSelector()
    assert.equal(selector.classify(makeRequest()), 'simple')
    assert.equal(selector.classify(makeRequest({ enforce_json: true })), 'complex')
  })
})

describe('pluggable interface', () => {
  it('accepts a custom Selector implementation', () => {
    // A custom selector that always returns 'complex'
    const alwaysComplex: Selector = {
      classify: (_req: ModelRequest): Classification => 'complex',
    }
    assert.equal(alwaysComplex.classify(makeRequest()), 'complex')
    assert.equal(alwaysComplex.classify(makeRequest({ messages: [] })), 'complex')
  })
})
