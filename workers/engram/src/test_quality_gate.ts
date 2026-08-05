/**
 * test_quality_gate.ts — Tests for QualityGate DSL.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parse,
  evaluate,
  defaultSimilarity,
  ValueError,
  type QualityGateSpec,
} from './quality_gate.js'

// ── Parse Tests ────────────────────────────────────────────────────────

describe('parse', () => {
  it('parses a valid contains gate spec', () => {
    const spec = parse({ gate_type: 'contains', value: 'hello' })
    assert.equal(spec.gate_type, 'contains')
    assert.equal(spec.value, 'hello')
    assert.equal(spec.required, true)
  })

  it('parses a valid equals gate spec', () => {
    const spec = parse({ gate_type: 'equals', value: 'exact match' })
    assert.equal(spec.gate_type, 'equals')
    assert.equal(spec.value, 'exact match')
  })

  it('parses a valid regex gate spec', () => {
    const spec = parse({ gate_type: 'regex', value: '^[A-Z].+\\d$' })
    assert.equal(spec.gate_type, 'regex')
    assert.equal(spec.value, '^[A-Z].+\\d$')
  })

  it('parses a valid length_range gate spec', () => {
    const spec = parse({ gate_type: 'length_range', value: [10, 100] })
    assert.equal(spec.gate_type, 'length_range')
    assert.deepEqual(spec.value, [10, 100])
  })

  it('parses a valid similarity_threshold gate spec', () => {
    const spec = parse({ gate_type: 'similarity_threshold', value: 0.75 })
    assert.equal(spec.gate_type, 'similarity_threshold')
    assert.equal(spec.value, 0.75)
  })

  it('accepts required: false', () => {
    const spec = parse({ gate_type: 'contains', value: 'x', required: false })
    assert.equal(spec.required, false)
  })

  it('throws ValueError for null input', () => {
    assert.throws(() => parse(null as any), ValueError)
  })

  it('throws ValueError for undefined input', () => {
    assert.throws(() => parse(undefined as any), ValueError)
  })

  it('throws ValueError for invalid gate_type', () => {
    assert.throws(
      () => parse({ gate_type: 'bogus', value: 'x' }),
      /Invalid gate_type/,
    )
  })

  it('throws ValueError for missing value in contains gate', () => {
    assert.throws(
      () => parse({ gate_type: 'contains', value: 123 }),
      /requires value to be a string/,
    )
  })

  it('throws ValueError for invalid length_range array', () => {
    assert.throws(
      () => parse({ gate_type: 'length_range', value: 'not-array' }),
      /requires value to be a \[min, max\] tuple/,
    )
  })

  it('throws ValueError for length_range with non-numbers', () => {
    assert.throws(
      () => parse({ gate_type: 'length_range', value: ['a', 'b'] }),
      /to be numbers/,
    )
  })

  it('throws ValueError for length_range with negative values', () => {
    assert.throws(
      () => parse({ gate_type: 'length_range', value: [-5, 10] }),
      /non-negative/,
    )
  })

  it('throws ValueError for length_range with min > max', () => {
    assert.throws(
      () => parse({ gate_type: 'length_range', value: [50, 10] }),
      /min <= max/,
    )
  })

  it('throws ValueError for similarity_threshold with non-numeric value', () => {
    assert.throws(
      () => parse({ gate_type: 'similarity_threshold', value: 'high' }),
      /to be a number/,
    )
  })

  it('throws ValueError for similarity_threshold out of range', () => {
    assert.throws(
      () => parse({ gate_type: 'similarity_threshold', value: 1.5 }),
      /in range/,
    )
    assert.throws(
      () => parse({ gate_type: 'similarity_threshold', value: -0.1 }),
      /in range/,
    )
  })

  it('throws ValueError for invalid regex pattern', () => {
    assert.throws(
      () => parse({ gate_type: 'regex', value: '[invalid' }),
      /valid regex/,
    )
  })
})

// ── Evaluate Tests ─────────────────────────────────────────────────────

describe('evaluate', () => {
  // ── contains ──

  it('contains gate passes when output contains the value', () => {
    const spec: QualityGateSpec = { gate_type: 'contains', value: 'world', required: true }
    const result = evaluate(spec, 'hello world!')
    assert.equal(result.passed, true)
    assert.ok(result.reasons.length > 0)
  })

  it('contains gate fails when output does not contain the value', () => {
    const spec: QualityGateSpec = { gate_type: 'contains', value: 'xyz', required: true }
    const result = evaluate(spec, 'hello world')
    assert.equal(result.passed, false)
    assert.ok(result.reasons[0].includes('does not contain'))
  })

  // ── equals ──

  it('equals gate passes when output matches exactly', () => {
    const spec: QualityGateSpec = { gate_type: 'equals', value: 'hello', required: true }
    const result = evaluate(spec, 'hello')
    assert.equal(result.passed, true)
  })

  it('equals gate strips whitespace before comparing', () => {
    const spec: QualityGateSpec = { gate_type: 'equals', value: 'hello', required: true }
    const result = evaluate(spec, '  hello  ')
    assert.equal(result.passed, true)
  })

  it('equals gate fails when output does not match', () => {
    const spec: QualityGateSpec = { gate_type: 'equals', value: 'hello', required: true }
    const result = evaluate(spec, 'world')
    assert.equal(result.passed, false)
  })

  // ── regex ──

  it('regex gate passes when output matches pattern', () => {
    const spec: QualityGateSpec = { gate_type: 'regex', value: '^\\d{3}-\\d{4}$', required: true }
    const result = evaluate(spec, '555-1234')
    assert.equal(result.passed, true)
  })

  it('regex gate fails when output does not match pattern', () => {
    const spec: QualityGateSpec = { gate_type: 'regex', value: '^\\d{3}-\\d{4}$', required: true }
    const result = evaluate(spec, '555-123')
    assert.equal(result.passed, false)
  })

  // ── length_range ──

  it('length_range gate passes when output length is within range', () => {
    const spec: QualityGateSpec = { gate_type: 'length_range', value: [5, 20], required: true }
    const result = evaluate(spec, 'hello world')
    assert.equal(result.passed, true)
  })

  it('length_range gate passes at exact minimum', () => {
    const spec: QualityGateSpec = { gate_type: 'length_range', value: [5, 20], required: true }
    const result = evaluate(spec, 'hello')
    assert.equal(result.passed, true)
  })

  it('length_range gate passes at exact maximum', () => {
    const spec: QualityGateSpec = { gate_type: 'length_range', value: [5, 5], required: true }
    const result = evaluate(spec, 'hello')
    assert.equal(result.passed, true)
  })

  it('length_range gate fails when output is too short', () => {
    const spec: QualityGateSpec = { gate_type: 'length_range', value: [10, 20], required: true }
    const result = evaluate(spec, 'short')
    assert.equal(result.passed, false)
  })

  it('length_range gate fails when output is too long', () => {
    const spec: QualityGateSpec = { gate_type: 'length_range', value: [1, 5], required: true }
    const result = evaluate(spec, 'much too long output')
    assert.equal(result.passed, false)
  })

  // ── similarity_threshold ──

  it('similarity_threshold gate passes with high similarity', () => {
    const spec: QualityGateSpec = { gate_type: 'similarity_threshold', value: 0.8, required: true }
    // Same text — should be 1.0 similarity
    const result = evaluate(spec, 'hello world', 'hello world')
    assert.equal(result.passed, true)
  })

  it('similarity_threshold gate fails with low similarity', () => {
    const spec: QualityGateSpec = { gate_type: 'similarity_threshold', value: 0.9, required: true }
    // Very different text
    const result = evaluate(spec, 'abc', 'xyz')
    assert.equal(result.passed, false)
  })

  it('similarity_threshold gate fails when no reference_text provided', () => {
    const spec: QualityGateSpec = { gate_type: 'similarity_threshold', value: 0.5, required: true }
    const result = evaluate(spec, 'hello')
    assert.equal(result.passed, false)
    assert.ok(result.reasons[0].includes('requires reference_text'))
  })

  it('similarity_threshold uses injectable similarity_fn', () => {
    const spec: QualityGateSpec = { gate_type: 'similarity_threshold', value: 0.5, required: true }
    const mockFn = () => 0.95
    const result = evaluate(spec, 'anything', 'anything else', mockFn)
    assert.equal(result.passed, true)
  })

  it('similarity_threshold respects custom threshold', () => {
    const spec: QualityGateSpec = { gate_type: 'similarity_threshold', value: 0.5, required: true }
    const mockFn = () => 0.3
    const result = evaluate(spec, 'x', 'y', mockFn)
    assert.equal(result.passed, false)
  })
})

// ── Multiple Gates Combined ────────────────────────────────────────────

describe('multiple gates combined (all must pass)', () => {
  it('passes when all gates pass', () => {
    const output = 'Hello world and goodbye'
    const specs: QualityGateSpec[] = [
      { gate_type: 'contains', value: 'world', required: true },
      { gate_type: 'length_range', value: [10, 100], required: true },
      { gate_type: 'regex', value: '^Hello', required: true },
    ]

    for (const spec of specs) {
      const result = evaluate(spec, output)
      assert.equal(result.passed, true, `Gate ${spec.gate_type} should pass`)
    }
  })

  it('fails when any single gate fails', () => {
    const output = 'Hello world'
    const containsResult = evaluate(
      { gate_type: 'contains', value: 'goodbye', required: true },
      output,
    )
    const lengthResult = evaluate(
      { gate_type: 'length_range', value: [50, 100], required: true },
      output,
    )

    assert.equal(containsResult.passed, false)
    assert.equal(lengthResult.passed, false)
  })
})

// ── Default Similarity ─────────────────────────────────────────────────

describe('defaultSimilarity', () => {
  it('returns 0 for empty strings', () => {
    assert.equal(defaultSimilarity('', ''), 0)
    assert.equal(defaultSimilarity('hello', ''), 0)
    assert.equal(defaultSimilarity('', 'world'), 0)
  })

  it('returns 1 for identical strings', () => {
    assert.equal(defaultSimilarity('hello world', 'hello world'), 1)
  })

  it('returns a value between 0 and 1 for similar strings', () => {
    const score = defaultSimilarity('hello world', 'hello there')
    assert.ok(score > 0, 'similar strings should have non-zero similarity')
    assert.ok(score < 1, 'different strings should have score < 1')
  })
})
