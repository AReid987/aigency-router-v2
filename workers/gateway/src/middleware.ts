/**
 * Middleware — rate-limiting, admin auth, CORS, and request-size-limit helpers.
 *
 * createRateLimitMiddleware wraps the module-level getActiveRateLimiter
 * (from S01's rate-limiter.ts) and consumes a rate-limit key per request.
 *
 * createAdminAuthMiddleware performs constant-time token comparison
 * for /v1/admin/ routes. Gate is off when token is unset.
 *
 * createCorsMiddleware applies CORS headers per the GATEWAY_CORS_* env
 * config. Env-gated default-off: returns a no-op middleware when
 * GATEWAY_CORS is unset. The preflight handler short-circuits at
 * chain position 0 so OPTIONS never reaches admin auth or size limit.
 *
 * createSizeLimitMiddleware rejects oversized request bodies with 413.
 * Env-gated default-off: noop when GATEWAY_MAX_REQUEST_BYTES is unset.
 * Content-Length over limit → 413 + JSON body. Missing Content-Length
 * with streaming body over limit → socket.destroy() (no response body).
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
  /**
   * Optional pre-built limiter override for testing.
   * When provided, getActiveRateLimiter is NOT imported dynamically.
   */
  limiter?: { consume: (k: string) => RateLimitResult }
}

export interface AdminAuthMiddlewareOpts {
  token?: string
  telemetry?: { emit: (eventClass: string, data: any) => void }
}

export interface CorsMiddlewareOpts {
  allowedOrigins: string[]
  allowedMethods: string[]
  allowedHeaders: string[]
  maxAge: number
  credentials: boolean
  telemetry?: { emit: (eventClass: string, data: any) => void }
}

export interface CorsResult {
  handled: boolean
  status: number
  headers: Record<string, string> | null
}

export interface SizeLimitMiddlewareOpts {
  maxBytes: number
  telemetry?: { emit: (eventClass: string, data: any) => void }
}

export interface SizeLimitResult {
  rejected: boolean
  status: number
  body?: string
  destroySocket?: boolean
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

  return async (req: Record<string, any>): Promise<RateLimitResult> => {
    const key = keyExtractor(req) ?? 'anonymous'

    let limiter: { consume: (k: string) => RateLimitResult }

    if (opts.limiter) {
      limiter = opts.limiter
    } else {
      // Dynamic import to avoid hard dependency — rate-limiter.ts is created by S01.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getActiveRateLimiter } = await import('./rate-limiter.ts') as {
        getActiveRateLimiter: () => { consume: (k: string) => RateLimitResult }
      }
      limiter = getActiveRateLimiter()
    }

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

// ── CORS Middleware ──────────────────────────────────────────────────

const DEFAULT_ALLOWED_METHODS = ['GET', 'POST']
const DEFAULT_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'x-api-key',
  'x-admin-token',
]
const DEFAULT_MAX_AGE = 86400

/**
 * Parse a CSV env value into a trimmed non-empty array. Returns undefined
 * for empty / unset input — callers can fall back to their default.
 */
export function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return items.length > 0 ? items : undefined
}

/**
 * Create a CORS middleware.
 *
 * Behavior:
 *   - OPTIONS preflight from a request on /v1/*: respond 204 with the
 *     configured CORS headers (when origin is in the allow-list) and do
 *     NOT call next(). Disallowed origin: respond 204 with the CORS
 *     headers omitted — let the browser block. We do not 403 preflights.
 *   - Non-preflight request: return headers to attach to the response so
 *     http-handler can set them after next() resolves.
 *
 * The factory reads opts directly; getActiveCorsMiddleware() reads env.
 */
export function createCorsMiddleware(
  opts: CorsMiddlewareOpts,
): (req: Record<string, any>) => CorsResult {
  const allowedOrigins = new Set(opts.allowedOrigins)
  const allowedMethods = opts.allowedMethods.join(', ')
  const allowedHeaders = opts.allowedHeaders.join(', ')
  const maxAge = String(opts.maxAge)

  return (req: Record<string, any>): CorsResult => {
    const method = (req.method ?? 'GET').toUpperCase()
    const isPreflight = method === 'OPTIONS'
    const origin = req.headers?.origin ?? req.headers?.Origin
    const isAllowedOrigin =
      typeof origin === 'string' && allowedOrigins.has(origin)

    if (isPreflight) {
      if (isAllowedOrigin) {
        if (opts.telemetry) {
          opts.telemetry.emit('CORS_PREFLIGHT_OK', {
            path: req.url ?? req.path,
            origin,
            method: req.headers?.['access-control-request-method'] ?? null,
          })
        }
        return {
          handled: true,
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': allowedMethods,
            'Access-Control-Allow-Headers': allowedHeaders,
            'Access-Control-Max-Age': maxAge,
            ...(opts.credentials
              ? { 'Access-Control-Allow-Credentials': 'true' }
              : {}),
          },
        }
      } else {
        if (opts.telemetry) {
          opts.telemetry.emit('CORS_PREFLIGHT_REJECTED', {
            path: req.url ?? req.path,
            origin: origin ?? null,
          })
        }
        // Disallowed origin: respond 204 but omit Access-Control-Allow-Origin
        // so the browser blocks the actual request client-side. We do not 403.
        return { handled: true, status: 204, headers: null }
      }
    }

    // Non-preflight: return headers for the handler to attach to the response.
    if (isAllowedOrigin) {
      return {
        handled: false,
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': origin,
          ...(opts.credentials
            ? { 'Access-Control-Allow-Credentials': 'true' }
            : {}),
        },
      }
    }

    return { handled: false, status: 200, headers: null }
  }
}

/**
 * Read CORS config from env and return a middleware (or a no-op when the
 * gate is off). Gate is `GATEWAY_CORS=true`; env vars:
 *   - GATEWAY_CORS_ALLOWED_ORIGINS (CSV; required when gate is on)
 *   - GATEWAY_CORS_ALLOWED_METHODS (CSV; default GET,POST)
 *   - GATEWAY_CORS_ALLOWED_HEADERS (CSV; default Content-Type, Authorization,
 *     x-api-key, x-admin-token)
 *   - GATEWAY_CORS_MAX_AGE (integer seconds; default 86400)
 *   - GATEWAY_CORS_CREDENTIALS (boolean; default false)
 */
export function getActiveCorsMiddleware(
  telemetry?: { emit: (eventClass: string, data: any) => void },
): (req: Record<string, any>) => CorsResult {
  const enabled = process.env.GATEWAY_CORS?.toLowerCase() === 'true'
  if (!enabled) {
    // No-op: do not short-circuit, do not add headers
    return (_req: Record<string, any>): CorsResult => ({
      handled: false,
      status: 200,
      headers: null,
    })
  }

  const allowedOrigins = parseCsv(process.env.GATEWAY_CORS_ALLOWED_ORIGINS) ?? []
  const allowedMethods =
    parseCsv(process.env.GATEWAY_CORS_ALLOWED_METHODS) ?? DEFAULT_ALLOWED_METHODS
  const allowedHeaders =
    parseCsv(process.env.GATEWAY_CORS_ALLOWED_HEADERS) ?? DEFAULT_ALLOWED_HEADERS
  const maxAge = Number.parseInt(process.env.GATEWAY_CORS_MAX_AGE ?? '', 10)
  const credentials =
    process.env.GATEWAY_CORS_CREDENTIALS?.toLowerCase() === 'true'

  if (allowedOrigins.length === 0) {
    // Gate on but no origins configured: no-op (safe default — no headers leaked)
    return (_req: Record<string, any>): CorsResult => ({
      handled: false,
      status: 200,
      headers: null,
    })
  }

  return createCorsMiddleware({
    allowedOrigins,
    allowedMethods,
    allowedHeaders,
    maxAge: Number.isFinite(maxAge) ? maxAge : DEFAULT_MAX_AGE,
    credentials,
    telemetry,
  })
}

// ── Size-Limit Middleware ────────────────────────────────────────────

/**
 * Create a request-size-limit middleware.
 *
 * Behavior:
 *   - Content-Length header present and over maxBytes: reject with
 *     413 + JSON body { error: 'request_too_large', maxBytes }.
 *   - Content-Length header missing (chunked or unknown): attach a data
 *     listener that accumulates bytes; on threshold breach destroy the
 *     socket (no response body).
 *   - Content-Length present and within maxBytes: pass-through.
 *
 * The factory returns a function that takes a request and returns a
 * decision. The caller is responsible for inspecting the result and
 * sending the 413 response or attaching the data listener.
 */
export function createSizeLimitMiddleware(
  opts: SizeLimitMiddlewareOpts,
): (req: Record<string, any>) => SizeLimitResult {
  const maxBytes = opts.maxBytes

  return (req: Record<string, any>): SizeLimitResult => {
    const clHeader = req.headers?.['content-length'] ?? req.headers?.['Content-Length']

    if (clHeader !== undefined && clHeader !== null && clHeader !== '') {
      const declared = Number.parseInt(String(clHeader), 10)
      if (Number.isFinite(declared) && declared > maxBytes) {
        if (opts.telemetry) {
          opts.telemetry.emit('REQUEST_TOO_LARGE', {
            path: req.url ?? req.path,
            method: req.method,
            bytesReceived: 0,
            maxBytes,
            source: 'content_length',
          })
        }
        return {
          rejected: true,
          status: 413,
          body: JSON.stringify({ error: 'request_too_large', maxBytes }),
        }
      }
      // Content-Length within limit: pass-through without attaching listener
      return { rejected: false, status: 200 }
    }

    // Missing Content-Length: caller must attach a data listener to enforce
    // the streaming limit. The factory returns a separate helper.
    return {
      rejected: false,
      status: 200,
      destroySocket: false,
    }
  }
}

/**
 * Attach a streaming-size listener to a Node IncomingMessage. If the
 * cumulative body exceeds maxBytes, the socket is destroyed and the
 * REQUEST_TOO_LARGE telemetry event is emitted. Returns a teardown
 * function the caller can invoke to remove the listener (e.g. when the
 * request completes normally).
 */
export function attachStreamingSizeGuard(
  req: NodeJS.ReadableStream & {
    on: (event: string, listener: (...args: any[]) => void) => unknown
    removeListener: (event: string, listener: (...args: any[]) => void) => unknown
  },
  socket: { destroy: (err?: Error) => void } | undefined,
  maxBytes: number,
  telemetry?: { emit: (eventClass: string, data: any) => void },
  pathAndMethod?: { path: string | undefined; method: string | undefined },
): () => void {
  let received = 0
  let tripped = false
  const onData = (chunk: Buffer | string): void => {
    received +=
      typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    if (!tripped && received > maxBytes) {
      tripped = true
      if (telemetry) {
        telemetry.emit('REQUEST_TOO_LARGE', {
          path: pathAndMethod?.path ?? null,
          method: pathAndMethod?.method ?? null,
          bytesReceived: received,
          maxBytes,
          source: 'streaming',
        })
      }
      try {
        socket?.destroy()
      } catch {
        // best-effort
      }
    }
  }
  req.on('data', onData)
  return () => req.removeListener('data', onData)
}

/**
 * Read size-limit config from env and return a middleware (or a no-op
 * when the gate is off). Gate is `GATEWAY_MAX_REQUEST_BYTES` (integer
 * bytes; unset/empty/malformed means noop).
 */
export function getActiveSizeLimitMiddleware(
  telemetry?: { emit: (eventClass: string, data: any) => void },
): (req: Record<string, any>) => SizeLimitResult {
  const raw = process.env.GATEWAY_MAX_REQUEST_BYTES
  if (!raw) {
    return (_req: Record<string, any>): SizeLimitResult => ({
      rejected: false,
      status: 200,
    })
  }
  const maxBytes = Number.parseInt(raw, 10)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return (_req: Record<string, any>): SizeLimitResult => ({
      rejected: false,
      status: 200,
    })
  }
  return createSizeLimitMiddleware({ maxBytes, telemetry })
}
