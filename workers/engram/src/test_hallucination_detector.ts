/**
 * test_hallucination_detector.ts — Tests for HallucinationDetector.
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  HallucinationDetector,
  cosineSimilarity,
  type EmbedFn,
} from './hallucination_detector.js'

// ── Cosine Similarity Tests ───────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const score = cosineSimilarity([1, 2, 3], [1, 2, 3])
    assert.equal(score, 1)
  })

  it('returns 0 for orthogonal vectors', () => {
    const score = cosineSimilarity([1, 0], [0, 1])
    assert.equal(score, 0)
  })

  it('returns a value between 0 and 1 for partially similar vectors', () => {
    const score = cosineSimilarity([1, 2, 3], [1, 2, 1])
    assert.ok(score > 0, 'should be non-zero')
    assert.ok(score < 1, 'should be less than 1')
  })

  it('returns 0 when one vector is all zeros', () => {
    const score = cosineSimilarity([0, 0, 0], [1, 2, 3])
    assert.equal(score, 0)
  })

  it('returns 0 when both vectors are all zeros', () => {
    const score = cosineSimilarity([0, 0], [0, 0])
    assert.equal(score, 0)
  })

  it('throws on dimension mismatch', () => {
    assert.throws(
      () => cosineSimilarity([1, 2, 3], [1, 2]),
      /dimension mismatch/,
    )
  })
})

// ── HallucinationDetector Tests ────────────────────────────────────────

describe('HallucinationDetector', () => {
  // ── High similarity (passes) ──

  it('reports no hallucination for high similarity (passes)', async () => {
    const embedFn: EmbedFn = () => [1, 0, 0]
    const detector = new HallucinationDetector(embedFn, 0.6)
    const result = await detector.evaluate('hello', 'hello')
    assert.equal(result.isHallucination, false)
    assert.equal(result.score, 1)
  })

  // ── Low similarity (flagged) ──

  it('reports hallucination for low similarity (flagged)', async () => {
    const embedFn: EmbedFn = (text: string) => {
      // Return different vectors for different texts
      if (text === 'hello') return [1, 0, 0]
      return [0, 1, 0] // orthogonal = 0 similarity
    }
    const detector = new HallucinationDetector(embedFn, 0.6)
    const result = await detector.evaluate('hello', 'world')
    assert.equal(result.isHallucination, true)
    assert.equal(result.score, 0)
  })

  // ── Empty strings ──

  it('returns 0 similarity and flagged for empty output', async () => {
    const embedFn: EmbedFn = () => [1, 0, 0]
    const detector = new HallucinationDetector(embedFn)
    const result = await detector.evaluate('', 'reference')
    assert.equal(result.score, 0)
    assert.equal(result.isHallucination, true)
  })

  it('returns 0 similarity and flagged for empty reference', async () => {
    const embedFn: EmbedFn = () => [1, 0, 0]
    const detector = new HallucinationDetector(embedFn)
    const result = await detector.evaluate('output', '')
    assert.equal(result.score, 0)
    assert.equal(result.isHallucination, true)
  })

  it('returns 0 similarity and flagged when both are empty', async () => {
    const embedFn: EmbedFn = () => [1, 0, 0]
    const detector = new HallucinationDetector(embedFn)
    const result = await detector.evaluate('', '')
    assert.equal(result.score, 0)
    assert.equal(result.isHallucination, true)
  })

  // ── Custom threshold ──

  it('respects a low custom threshold (fails at moderate similarity)', async () => {
    const embedFn: EmbedFn = (text: string) => {
      // Return 75% similar vectors
      if (text === 'hello') return [1, 0, 0]
      return [0.75, 0.661, 0] // approx 0.75 cosine sim to [1,0,0]
    }
    // Threshold 0.8 — 0.75 is below it
    const detector = new HallucinationDetector(embedFn, 0.8)
    const result = await detector.evaluate('hello', 'world')
    assert.equal(result.isHallucination, true)
    assert.ok(result.score < 0.8)
  })

  it('respects a high custom threshold (passes at moderate similarity)', async () => {
    // Using the mock embed fn that returns [1,0,0] for both
    const embedFn: EmbedFn = () => [1, 0, 0]
    // Threshold 0.2 — 1.0 is well above it
    const detector = new HallucinationDetector(embedFn, 0.2)
    const result = await detector.evaluate('hello', 'world')
    assert.equal(result.isHallucination, false)
    assert.equal(result.score, 1)
  })

  // ── Injectable embed_fn ──

  it('uses injectable embed_fn (mock)', async () => {
    const mockEmbedFn = mock.fn(async (text: string) => {
      const map: Record<string, number[]> = {
        a: [1, 0, 0],
        b: [0.9, 0.1, 0],
      }
      return map[text] ?? [0, 0, 0]
    })

    const detector = new HallucinationDetector(mockEmbedFn, 0.8)
    const result = await detector.evaluate('a', 'b')

    assert.equal(mockEmbedFn.mock.callCount(), 2)
    assert.equal(result.isHallucination, false)
    assert.ok(result.score >= 0.8)
  })

  // ── Async embed_fn ──

  it('works with async embed_fn', async () => {
    const embedFn: EmbedFn = async (text: string) => {
      // Simulate async embedding model
      await Promise.resolve()
      if (text === 'same') return [1, 0]
      if (text === 'different') return [0, 1]
      return [0.5, 0.5]
    }
    const detector = new HallucinationDetector(embedFn, 0.5)
    const passResult = await detector.evaluate('same', 'same')
    assert.equal(passResult.isHallucination, false)

    // 'different' returns [0,1], 'same' returns [1,0] — orthogonal = 0
    const failResult = await detector.evaluate('different', 'same')
    assert.equal(failResult.isHallucination, true)
  })
})
