/**
 * Middleware — rate-limiting and admin auth helpers.
 *
 * createRateLimitMiddleware wraps the module-level getActiveRateLimiter
 * (from S01's rate-limiter.ts) and consumes a rate-limit key per request.
 *
 * createAdminAuthMiddleware performs constant-time token comparison
 * for /v1/admin/ routes. Gate is off when token is unset.
 */

import crypto from 'node:crypto'

// ── Types ──────────────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs?: number
}

export interface RateLimitMiddlewareOpts {
  keyExtractor?: (req: Record<string, any>) => string | undefined
}

export interface AdminAuthMiddlewareOpts {
  token?: string
  telemetry?: { emit: (eventClass: string, data: any) => void }
}

// ── Rate-Limit Middleware ─────────────────────────────────────────────

/**
 * Create a rate-limit middleware that wraps getActiveRateLimiter.
 *
 * Default key extractor: x-api-key header → remoteAddress → 'anonymous'
 */
export function createRateLimitMiddleware(
  opts: RateLimitMiddlewareOpts = {},
): (req: Record<string, any>) => RateLimitResult {
  const keyExtractor =
    opts.keyExtractor ??
    ((req: Record<string, any>): string | undefined => {
      return (
        req.headers?.['x-api-key'] ??
        req.socket?.remoteAddress ??
        'anonymous'
      )
    })

  return (req: Record<string, any>): RateLimitResult => {
    const key = keyExtractor(req) ?? 'anonymous'

    // Dynamic import to avoid hard dependency — rate-limiter.ts is created by S01.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getActiveRateLimiter } = require('./rate-limiter.ts') as {
      getActiveRateLimiter: () => { consume: (k: string) => RateLimitResult }
    }

    const limiter = getActiveRateLimiter()
    return limiter.consume(key)
  }
}

// ── Admin Auth Middleware ────────────────────────────────────────────

/**
 * Create an admin auth middleware that validates x-admin-token headers.
 *
 * Uses crypto.timingSafeEqual for constant-time comparison to prevent
 * timing side-channel attacks.
 *
 * Returns true when:
 *   - token is undefined or empty (gate off)
 *   - x-admin-token header matches via constant-time compare
 *
 * Returns false otherwise. Emits AUTH_REJECTED telemetry on rejection
 * when a telemetry emitter is provided.
 */
export function createAdminAuthMiddleware(
  opts: AdminAuthMiddlewareOpts = {},
): (req: Record<string, any>) => boolean {
  const configuredToken = opts.token

  return (req: Record<string, any>): boolean => {
    // Gate off if no token configured
    if (!configuredToken) return true

    const headerToken = req.headers?.['x-admin-token']

    // Missing header
    if (!headerToken) {
      if (opts.telemetry) {
        opts.telemetry.emit('AUTH_REJECTED', {
          path: req.url ?? req.path,
          method: req.method,
          reason: 'missing_token',
        })
      }
      return false
    }

    // Constant-time comparison to prevent timing side-channels
    const configuredBuf = Buffer.from(configuredToken)
    const headerBuf = Buffer.from(headerToken)

    if (configuredBuf.length !== headerBuf.length) {
      if (opts.telemetry) {
        opts.telemetry.emit('AUTH_REJECTED', {
          path: req.url ?? req.path,
          method: req.method,
          reason: 'token_mismatch',
        })
      }
      return false
    }

    const match = crypto.timingSafeEqual(configuredBuf, headerBuf)

    if (!match && opts.telemetry) {
      opts.telemetry.emit('AUTH_REJECTED', {
        path: req.url ?? req.path,
        method: req.method,
        reason: 'token_mismatch',
      })
    }

    return match
  }
}
