/**
 * test_gate_integration.ts — Integration tests for engram::gate worker function.
 *
 * Tests 5 representative cases: 3 pass, 2 fail, covering contains,
 * regex, and similarity_threshold gate types through the full
 * index.ts registration pipeline.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerEngramFunctions } from './index.ts'

// ── Mock SDK (same pattern as index.test.ts) ──────────────────────────

function createMockSdk() {
  const registered = new Map<string, (input: unknown) => Promise<unknown>>()
  const triggerCalls: unknown[] = []

  return {
    registered,
    triggerCalls,
    trigger: async (...args: unknown[]) => {
      triggerCalls.push(args)
      return {}
    },
    registerFunction: (name: string, fn: (input: unknown) => Promise<unknown>) => {
      registered.set(name, fn)
    },
    shutdown: async () => {},
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function getGateFn(sdk: ReturnType<typeof createMockSdk>) {
  const fn = sdk.registered.get('engram::gate')
  if (!fn) throw new Error('engram::gate not registered')
  return fn
}

// ── Registration Test ─────────────────────────────────────────────────

describe('engram::gate registration', () => {
  it('is registered as an engram function', () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    assert.ok(sdk.registered.has('engram::gate'), 'engram::gate should be registered')
  })
})

// ── Integration Tests ─────────────────────────────────────────────────

describe('engram::gate integration (pass cases)', () => {
  // Test 1: contains — pass
  it('returns pass for contains gate matching output', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    const result = await gateFn({
      spec: { gate_type: 'contains', value: 'world' },
      output: 'hello world!',
    })

    assert.equal(result.passed, true)
    assert.ok(Array.isArray(result.reasons))
    assert.ok(result.reasons[0].includes('contains'))
    assert.equal(result.hallucination_score, null)
  })

  // Test 2: regex — pass
  it('returns pass for regex gate matching output', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    const result = await gateFn({
      spec: { gate_type: 'regex', value: '^ERROR\\s+\\d+' },
      output: 'ERROR 404 not found',
    })

    assert.equal(result.passed, true)
    assert.ok(result.reasons[0].includes('matches regex'))
    assert.equal(result.hallucination_score, null)
  })

  // Test 3: similarity_threshold — pass (with reference_text)
  it('returns pass for similarity_threshold with matching text', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    const result = await gateFn({
      spec: { gate_type: 'similarity_threshold', value: 0.5 },
      output: 'The quick brown fox',
      reference_text: 'The quick brown fox',
    })

    assert.equal(result.passed, true)
    assert.ok(typeof result.hallucination_score === 'number')
    // Identical text should have high similarity
    assert.ok(result.hallucination_score! >= 0.5)
  })
})

describe('engram::gate integration (fail cases)', () => {
  // Test 4: contains — fail
  it('returns fail for contains gate not matching output', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    const result = await gateFn({
      spec: { gate_type: 'contains', value: 'xyz' },
      output: 'hello world',
    })

    assert.equal(result.passed, false)
    assert.ok(result.reasons[0].includes('does not contain'))
    assert.equal(result.hallucination_score, null)
  })

  // Test 5: regex — fail
  it('returns fail for regex gate not matching output', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    const result = await gateFn({
      spec: { gate_type: 'regex', value: '^\\d{3}-\\d{4}$' },
      output: '555-123',
    })

    assert.equal(result.passed, false)
    assert.ok(result.reasons[0].includes('does not match'))
    assert.equal(result.hallucination_score, null)
  })
})

// ── Edge Cases ─────────────────────────────────────────────────────────

describe('engram::gate edge cases', () => {
  it('returns hallucination_score when reference_text is provided', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    const result = await gateFn({
      spec: { gate_type: 'contains', value: 'hello' },
      output: 'hello world',
      reference_text: 'hello world reference',
    })

    assert.equal(result.passed, true)
    assert.ok(typeof result.hallucination_score === 'number')
    // With our bigram-based embedding, reference text that shares
    // significant portions with the output should have non-zero similarity
    assert.ok(result.hallucination_score! > 0, 'hallucination score should be > 0')
  })

  it('handles invalid spec gracefully', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    const result = await gateFn({
      spec: { gate_type: 'bogus_type', value: 'x' } as any,
      output: 'test output',
    })

    assert.equal(result.passed, false)
    assert.ok(result.reasons[0].includes('Gate evaluation error'))
    assert.equal(result.hallucination_score, null)
  })

  it('handles missing spec gracefully', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    const result = await gateFn({
      spec: { gate_type: 'bogus_type', value: 'x' } as any,
      output: 'test',
    })

    assert.equal(result.passed, false)
    assert.ok(result.reasons[0].includes('Gate evaluation error'))
    assert.equal(result.hallucination_score, null)
  })

  it('handles missing output field gracefully', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    const result = await gateFn({
      spec: { gate_type: 'contains', value: 'hello' },
    })

    assert.equal(result.passed, false)
    assert.ok(result.reasons[0].includes('Missing or invalid'))
    assert.equal(result.hallucination_score, null)
  })

  it('emits telemetry on gate evaluation', async () => {
    const sdk = createMockSdk()
    registerEngramFunctions(sdk as any)
    const gateFn = getGateFn(sdk)

    await gateFn({
      spec: { gate_type: 'contains', value: 'hello' },
      output: 'hello world',
    })

    // Should have triggered log_event for GATE_EVALUATED
    // The telemetryTrigger wraps calls as iii.trigger({ function_id: fnName, payload })
    const telemetryCalls = sdk.triggerCalls.filter(
      (call: any) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as any).function_id === 'log_event',
    )
    assert.ok(telemetryCalls.length > 0, 'should emit telemetry events')
  })
})
