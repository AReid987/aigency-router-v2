/**
 * TierProbe — probes a provider endpoint and classifies the tier
 * from the HTTP response headers and status code.
 *
 * Injects httpFetch for testability; defaults to globalThis.fetch
 * with AbortSignal.timeout(timeoutMs).
 */

import type { TelemetryDeps } from '../../../shared/telemetry.ts'

// ── Types ──────────────────────────────────────────────────────────────

export interface RateLimitInfo {
  requestsRemaining?: number
  tokensRemaining?: number
  retryAfter?: number
  limitRequests?: number
  limitTokens?: number
}

export interface ProbeResult {
  tier: 'free' | 'paid' | 'free_but_exhausted' | 'unknown'
  rateLimits: RateLimitInfo | null
  probedAt: number
  latencyMs: number
  error?: string
}

export interface TierProbeOptions {
  httpFetch?: typeof globalThis.fetch
  timeoutMs?: number
  telemetryDeps?: TelemetryDeps
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Parse an integer header value, returning undefined for missing/invalid. */
function parseIntHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)
  if (raw === null) return undefined
  const val = Number.parseInt(raw, 10)
  return Number.isFinite(val) ? val : undefined
}

/** Attempt to parse a response body for classification keywords. */
async function bodyContainsPaymentRequired(res: Response): Promise<boolean> {
  try {
    const body = await res.text()
    return body.toLowerCase().includes('payment_required')
  } catch {
    return false
  }
}

// ── TierProbe ──────────────────────────────────────────────────────────

export class TierProbe {
  private readonly httpFetch: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly telemetryDeps?: TelemetryDeps

  constructor(options?: TierProbeOptions) {
    this.httpFetch = options?.httpFetch ?? globalThis.fetch
    this.timeoutMs = options?.timeoutMs ?? 5_000
    this.telemetryDeps = options?.telemetryDeps
  }

  /**
   * Probe a provider endpoint and classify its tier.
   *
   * Sends a GET request to `${url}/v1/models` with an Authorization header
   * when apiKey is provided. Parses standard rate-limit headers and
   * classifies the tier from the response status + body.
   */
  async probe(url: string, apiKey?: string): Promise<ProbeResult> {
    const probedAt = Date.now()
    const startMs = performance.now()

    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
      }
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

      let response: Response
      try {
        response = await this.httpFetch(`${url}/v1/models`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeoutId)
      }

      const latencyMs = Math.round(performance.now() - startMs)

      return await this.classifyResponse(response, latencyMs, probedAt)
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startMs)
      return this.handleError(err, latencyMs, probedAt)
    }
  }

  // ── Classification ───────────────────────────────────────────────────

  private async classifyResponse(
    res: Response,
    latencyMs: number,
    probedAt: number,
  ): Promise<ProbeResult> {
    const headers = res.headers
    const status = res.status

    // Parse rate-limit headers
    const requestsRemaining = parseIntHeader(headers, 'x-ratelimit-remaining-requests')
    const tokensRemaining = parseIntHeader(headers, 'x-ratelimit-remaining-tokens')
    const retryAfter = parseIntHeader(headers, 'retry-after')
    const limitRequests = parseIntHeader(headers, 'x-ratelimit-limit-requests')
    const limitTokens = parseIntHeader(headers, 'x-ratelimit-limit-tokens')

    // Build RateLimitInfo when any header is present
    const rateLimits: RateLimitInfo | null =
      requestsRemaining !== undefined ||
      tokensRemaining !== undefined ||
      retryAfter !== undefined ||
      limitRequests !== undefined ||
      limitTokens !== undefined
        ? {
            ...(requestsRemaining !== undefined && { requestsRemaining }),
            ...(tokensRemaining !== undefined && { tokensRemaining }),
            ...(retryAfter !== undefined && { retryAfter }),
            ...(limitRequests !== undefined && { limitRequests }),
            ...(limitTokens !== undefined && { limitTokens }),
          }
        : null

    // ── 2xx ──────────────────────────────────────────────────────────
    if (status >= 200 && status < 300) {
      if (rateLimits && requestsRemaining !== undefined) {
        // 200 with rate-limit info
        this.emitTelemetry('TIER_PROBE_SUCCESS', {
          url: res.url,
          status,
          requestsRemaining,
          tokensRemaining,
        })
        return { tier: 'free', rateLimits, probedAt, latencyMs }
      }
      // 200 without rate-limit info — unlimited free tier
      this.emitTelemetry('TIER_PROBE_SUCCESS', {
        url: res.url,
        status,
        tier: 'free_unlimited',
      })
      return { tier: 'free', rateLimits: null, probedAt, latencyMs }
    }

    // ── 401 / 403 — paid tier ───────────────────────────────────────
    if (status === 401 || status === 403) {
      if (await bodyContainsPaymentRequired(res)) {
        this.emitTelemetry('TIER_PROBE_SUCCESS', {
          url: res.url,
          status,
          tier: 'paid',
        })
        return { tier: 'paid', rateLimits: null, probedAt, latencyMs }
      }
      // Best-effort: 401/403 without payment_required body still likely paid
      // But classify as unknown since we can't confirm
      this.emitTelemetry('TIER_PROBE_FAILED', {
        url: res.url,
        status,
        reason: 'no_payment_required_body',
      })
      return { tier: 'unknown', rateLimits: null, probedAt, latencyMs, error: `HTTP ${status} without payment_required body` }
    }

    // ── 429 — possibly exhausted ────────────────────────────────────
    if (status === 429) {
      if (requestsRemaining === 0 || retryAfter !== undefined) {
        this.emitTelemetry('TIER_PROBE_EXHAUSTED', {
          url: res.url,
          status,
          requestsRemaining,
          retryAfter,
        })
        return { tier: 'free_but_exhausted', rateLimits, probedAt, latencyMs }
      }
      // 429 without exhaustion signals
      this.emitTelemetry('TIER_PROBE_FAILED', {
        url: res.url,
        status,
        reason: 'rate_limited_unexpected',
      })
      return { tier: 'unknown', rateLimits, probedAt, latencyMs, error: `HTTP 429 without exhaustion signal` }
    }

    // ── 5xx — server error ───────────────────────────────────────────
    if (status >= 500 && status < 600) {
      this.emitTelemetry('TIER_PROBE_FAILED', {
        url: res.url,
        status,
        reason: 'server_error',
      })
      return { tier: 'unknown', rateLimits: null, probedAt, latencyMs, error: `HTTP ${status} server error` }
    }

    // ── Other 4xx ─────────────────────────────────────────────────────
    if (status >= 400 && status < 500) {
      this.emitTelemetry('TIER_PROBE_FAILED', {
        url: res.url,
        status,
        reason: 'unexpected_client_error',
      })
      return { tier: 'unknown', rateLimits: null, probedAt, latencyMs, error: `HTTP ${status}` }
    }

    // ── Catch-all ────────────────────────────────────────────────────
    this.emitTelemetry('TIER_PROBE_FAILED', {
      url: res.url,
      status,
      reason: 'unexpected_status',
    })
    return { tier: 'unknown', rateLimits: null, probedAt, latencyMs, error: `HTTP ${status}` }
  }

  private handleError(
    err: unknown,
    latencyMs: number,
    probedAt: number,
  ): ProbeResult {
    const message = err instanceof Error ? err.message : String(err)
    const isTimeout = err instanceof DOMException && err.name === 'AbortError'

    this.emitTelemetry('TIER_PROBE_FAILED', {
      error: message,
      isTimeout,
    })

    return {
      tier: 'unknown',
      rateLimits: null,
      probedAt,
      latencyMs,
      error: isTimeout ? `timeout: ${message}` : message,
    }
  }

  // ── Telemetry ────────────────────────────────────────────────────────

  private emitTelemetry(
    eventClass: 'TIER_PROBE_SUCCESS' | 'TIER_PROBE_FAILED' | 'TIER_PROBE_EXHAUSTED',
    payload: Record<string, unknown>,
  ): void {
    if (!this.telemetryDeps) return

    this.telemetryDeps.trigger('sugar-db', 'log_event', {
      eventClass,
      sourceWorker: 'gateway',
      payload,
    }).catch(() => {
      // Fire-and-forget, graceful degradation
    })
  }
}
