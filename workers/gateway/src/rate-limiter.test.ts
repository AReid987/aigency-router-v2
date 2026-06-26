/**
 * rate-limiter.test.ts — Tests for the token-bucket rate limiter.
 *
 * Run: cd workers/gateway && tsx --test src/rate-limiter.test.ts
 *
 * S01 tasks T01 (rate-limiter.ts) + T02 (this file) of M019-ffp4ho.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRateLimiter,
  noopRateLimiter,
  getActiveRateLimiter,
} from './rate-limiter.ts'

// ── Test helpers ───────────────────────────────────────────────────────

/**
 * Drain a limiter by calling consume 'count' times and return the last result.
 */
function drain(limiter: ReturnType<typeof createRateLimiter>, key: string, count: number) {
  let result = limiter.consume(key)
  for (let i = 0; i < count - 1; i++) {
    result = limiter.consume(key)
  }
  return result
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('rate-limiter', () => {
  // ── 1. consume under capacity ─────────────────────────────────────

  it('consume under capacity returns allowed:true with correct remaining', () => {
    const limiter = createRateLimiter({ tokensPerWindow: 5, windowMs: 60000 })

    const r1 = limiter.consume('alpha')
    assert.equal(r1.allowed, true)
    assert.equal(r1.remaining, 4)

    const r2 = limiter.consume('alpha')
    assert.equal(r2.allowed, true)
    assert.equal(r2.remaining, 3)
  })

  // ── 2. drain bucket ──────────────────────────────────────────────

  it('consume that drains bucket returns false with retryAfterMs on last call', () => {
    const limiter = createRateLimiter({ tokensPerWindow: 3, windowMs: 60000 })

    // 3 allowed calls
    assert.equal(limiter.consume('beta').allowed, true)
    assert.equal(limiter.consume('beta').allowed, true)
    assert.equal(limiter.consume('beta').allowed, true)

    // 4th — denied
    const denied = limiter.consume('beta')
    assert.equal(denied.allowed, false)
    assert.equal(denied.remaining, 0)
    assert.ok(denied.retryAfterMs !== undefined, 'retryAfterMs must be set')
    assert.ok(denied.retryAfterMs! > 0, 'retryAfterMs must be positive')
  })

  // ── 3. keys are isolated ─────────────────────────────────────────

  it('two distinct keys do not share buckets', () => {
    const limiter = createRateLimiter({ tokensPerWindow: 3, windowMs: 60000 })

    // Drain key-a
    drain(limiter, 'key-a', 3)
    assert.equal(limiter.consume('key-a').allowed, false, 'key-a should be drained')

    // key-b should still have full capacity
    const b1 = limiter.consume('key-b')
    assert.equal(b1.allowed, true)
    assert.equal(b1.remaining, 2) // 3 - 1 = 2

    // Drain key-b
    limiter.reset('key-b')
    const bFresh = limiter.consume('key-b')
    assert.equal(bFresh.allowed, true)
    assert.equal(bFresh.remaining, 2, 'reset key-b should have full capacity minus 1')
  })

  // ── 4. tokens refill after windowMs ──────────────────────────────

  it('tokens refill after windowMs elapsed (passing now parameter)', () => {
    const limiter = createRateLimiter({ tokensPerWindow: 3, windowMs: 1000 })
    const start = 1_000_000

    // Drain at start — use explicit now to keep consistent timebase
    assert.equal(limiter.consume('charlie', start).allowed, true)
    assert.equal(limiter.consume('charlie', start).allowed, true)
    assert.equal(limiter.consume('charlie', start).allowed, true)

    // 4th at same moment — denied
    const denied = limiter.consume('charlie', start)
    assert.equal(denied.allowed, false)

    // After exactly windowMs has elapsed, tokens should refill
    const refilled = limiter.consume('charlie', start + 1000)
    assert.equal(refilled.allowed, true)
    assert.equal(refilled.remaining, 2) // refilled to 3, consumed 1 → 2
  })

  // ── 5. noopRateLimiter always returns allowed ────────────────────

  it('noopRateLimiter always returns allowed with 999_999 remaining', () => {
    // Even after many calls
    for (let i = 0; i < 1_000; i++) {
      const r = noopRateLimiter.consume(`spam-${i}`)
      assert.equal(r.allowed, true)
      assert.equal(r.remaining, 999_999)
      assert.equal(r.retryAfterMs, undefined)
    }

    // Any key
    const r = noopRateLimiter.consume('whatever')
    assert.equal(r.allowed, true)
    assert.equal(r.remaining, 999_999)
  })

  // ── 6. capacity ceiling ──────────────────────────────────────────

  it('tokens never exceed capacity even after long idle', () => {
    const limiter = createRateLimiter({ tokensPerWindow: 5, windowMs: 1000 })
    const start = 1_000_000

    // Consume one to create the bucket
    limiter.consume('delta', start)

    // Simulate 10x windowMs of idle time
    const farFuture = start + 10_000
    const r = limiter.consume('delta', farFuture)
    assert.equal(r.allowed, true)
    // Should have refilled to capacity (5) then consumed 1 → 4
    assert.equal(r.remaining, 4, 'tokens must not exceed capacity')
  })

  // ── 7. getActiveRateLimiter env gate ─────────────────────────────

  it('getActiveRateLimiter respects GATEWAY_RATE_LIMITING env var', () => {
    const saved = process.env.GATEWAY_RATE_LIMITING

    // Unset → returns noop
    delete process.env.GATEWAY_RATE_LIMITING
    let limiter = getActiveRateLimiter()
    assert.equal(limiter, noopRateLimiter, 'when unset should return noop')

    // Set → returns real limiter
    process.env.GATEWAY_RATE_LIMITING = 'true'
    limiter = getActiveRateLimiter()
    assert.notEqual(limiter, noopRateLimiter, 'when true should return real limiter')

    // Verify the real limiter works
    const result = limiter.consume('env-test')
    assert.equal(result.allowed, true)
    assert.equal(typeof result.remaining, 'number')

    // Unset again → returns noop
    delete process.env.GATEWAY_RATE_LIMITING
    limiter = getActiveRateLimiter()
    assert.equal(limiter, noopRateLimiter, 'back to unset should return noop again')

    // Restore
    if (saved !== undefined) {
      process.env.GATEWAY_RATE_LIMITING = saved
    }
  })
})
