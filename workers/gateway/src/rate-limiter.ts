/**
 * rate-limiter.ts — Per-key token-bucket rate limiter.
 *
 * API:
 *   createRateLimiter(opts)  → RateLimiter
 *   noopRateLimiter           → RateLimiter (always allowed)
 *   getActiveRateLimiter()    → RateLimiter (env-gated singleton)
 *
 * S01 of M019-ffp4ho.
 *
 * Run tests: cd workers/gateway && tsx --test src/rate-limiter.test.ts
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface RateLimiterOpts {
  tokensPerWindow: number
  windowMs: number
  maxKeys?: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs?: number
}

interface BucketState {
  tokens: number
  lastRefillMs: number
}

export interface RateLimiter {
  consume(key: string, now?: number): RateLimitResult
  reset(key?: string): void
}

// ── Internal helpers ───────────────────────────────────────────────────

/**
 * Refill a bucket's token count based on elapsed time.
 * Rate = tokensPerWindow tokens per windowMs ms.
 */
function refill(
  state: BucketState,
  now: number,
  capacity: number,
  tokensPerWindow: number,
  windowMs: number,
): void {
  const elapsed = now - state.lastRefillMs
  if (elapsed <= 0) return

  const accrued = (elapsed * tokensPerWindow) / windowMs
  state.tokens = Math.min(capacity, state.tokens + accrued)
  state.lastRefillMs = now
}

// ── Factory ────────────────────────────────────────────────────────────

export function createRateLimiter(opts: RateLimiterOpts): RateLimiter {
  const capacity = opts.tokensPerWindow
  const windowMs = opts.windowMs
  const maxKeys = opts.maxKeys ?? 10_000
  const buckets = new Map<string, BucketState>()

  function evictIfNeeded(): void {
    if (buckets.size > maxKeys) {
      // Map preserves insertion order — evict the oldest entry
      const firstKey = buckets.keys().next().value
      if (firstKey !== undefined) {
        buckets.delete(firstKey)
      }
    }
  }

  return {
    consume(key: string, now?: number): RateLimitResult {
      const t = now ?? Date.now()
      let state = buckets.get(key)

      if (state === undefined) {
        state = { tokens: capacity, lastRefillMs: t }
        buckets.set(key, state)
        evictIfNeeded()
      } else {
        refill(state, t, capacity, capacity, windowMs)
      }

      if (state.tokens >= 1) {
        state.tokens -= 1
        return { allowed: true, remaining: Math.floor(state.tokens) }
      }

      // Denied — calculate how long until at least 1 token is available
      const deficit = 1 - state.tokens
      const retryAfterMs = Math.ceil((deficit * windowMs) / capacity)
      return { allowed: false, remaining: 0, retryAfterMs }
    },

    reset(key?: string): void {
      if (key === undefined) {
        buckets.clear()
      } else {
        buckets.delete(key)
      }
    },
  }
}

// ── Noop singleton ────────────────────────────────────────────────────

export const noopRateLimiter: RateLimiter = {
  consume(_key: string, _now?: number): RateLimitResult {
    return { allowed: true, remaining: 999_999 }
  },
  reset(_key?: string): void {
    // noop
  },
}

// ── Active singleton (env-gated) ──────────────────────────────────────

let activeLimiter: RateLimiter | null = null

/**
 * Return the active rate limiter based on GATEWAY_RATE_LIMITING.
 *
 * When the env var is not 'true', returns the noop limiter.
 * When 'true', returns (or creates) a singleton configured from:
 *   GATEWAY_RATE_LIMIT_TOKENS   (default 100)
 *   GATEWAY_RATE_LIMIT_WINDOW_MS (default 60000)
 */
export function getActiveRateLimiter(): RateLimiter {
  if (process.env.GATEWAY_RATE_LIMITING !== 'true') {
    return noopRateLimiter
  }

  if (activeLimiter === null) {
    const tokens = parseInt(
      process.env.GATEWAY_RATE_LIMIT_TOKENS ?? '100',
      10,
    )
    const windowMs = parseInt(
      process.env.GATEWAY_RATE_LIMIT_WINDOW_MS ?? '60000',
      10,
    )
    activeLimiter = createRateLimiter({
      tokensPerWindow: Number.isNaN(tokens) ? 100 : tokens,
      windowMs: Number.isNaN(windowMs) ? 60000 : windowMs,
    })
  }

  return activeLimiter
}
