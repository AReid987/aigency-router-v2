/**
 * TierProbe unit tests.
 *
 * Tests the TierProbe class with injected httpFetch for controllable responses.
 * Uses node:test and node:assert/strict.
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { TierProbe } from './tier_probe.ts'
import type { ProbeResult } from './tier_probe.ts'

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a mock fetch that returns a controllable Response. */
function mockFetch(responseOpts: {
  status: number
  headers?: Record<string, string>
  body?: string
}): typeof globalThis.fetch {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(responseOpts.headers)
    return new Response(responseOpts.body ?? '', {
      status: responseOpts.status,
      headers,
    }) as Response
  }
}

/** Create a mock fetch that throws. */
function mockFetchError(error: Error): typeof globalThis.fetch {
  return async (): Promise<Response> => {
    throw error
  }
}

/** Assert common ProbeResult fields and return the result for further assertions. */
function assertProbeResult(
  result: ProbeResult,
  expected: {
    tier: ProbeResult['tier']
    rateLimitsNull?: boolean
    requestsRemaining?: number
    tokensRemaining?: number
    retryAfter?: number
    limitRequests?: number
    limitTokens?: number
    hasError?: boolean
    errorContains?: string
  },
): void {
  assert.equal(result.tier, expected.tier, `expected tier=${expected.tier}`)

  if (expected.rateLimitsNull) {
    assert.equal(result.rateLimits, null, 'rateLimits should be null')
  } else if (result.rateLimits !== null) {
    if (expected.requestsRemaining !== undefined) {
      assert.equal(result.rateLimits.requestsRemaining, expected.requestsRemaining)
    }
    if (expected.tokensRemaining !== undefined) {
      assert.equal(result.rateLimits.tokensRemaining, expected.tokensRemaining)
    }
    if (expected.retryAfter !== undefined) {
      assert.equal(result.rateLimits.retryAfter, expected.retryAfter)
    }
    if (expected.limitRequests !== undefined) {
      assert.equal(result.rateLimits.limitRequests, expected.limitRequests)
    }
    if (expected.limitTokens !== undefined) {
      assert.equal(result.rateLimits.limitTokens, expected.limitTokens)
    }
  }

  assert.ok(typeof result.probedAt === 'number', 'probedAt should be a number')
  assert.ok(result.probedAt > 0, 'probedAt should be > 0')
  assert.ok(typeof result.latencyMs === 'number', 'latencyMs should be a number')

  if (expected.hasError || expected.errorContains) {
    assert.ok(result.error !== undefined, 'should have an error')
    if (expected.errorContains) {
      assert.ok(result.error!.includes(expected.errorContains),
        `error "${result.error}" should contain "${expected.errorContains}"`)
    }
  } else {
    assert.equal(result.error, undefined, 'should not have an error')
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('TierProbe', () => {

  // ── 1. Free 200 with rate-limit headers ─────────────────────────────

  it('classifies 200 with x-ratelimit-remaining-requests as free with limits', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 200,
        headers: {
          'x-ratelimit-remaining-requests': '1000',
          'x-ratelimit-remaining-tokens': '50000',
          'x-ratelimit-limit-requests': '10000',
          'x-ratelimit-limit-tokens': '200000',
        },
      }),
    })

    const result = await probe.probe('https://api.groq.com/openai')

    assertProbeResult(result, {
      tier: 'free',
      requestsRemaining: 1000,
      tokensRemaining: 50000,
      limitRequests: 10000,
      limitTokens: 200000,
    })
  })

  // ── 2. Free 200 without rate-limit headers ──────────────────────────

  it('classifies 200 without rate-limit headers as free (unlimited)', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({ status: 200 }),
    })

    const result = await probe.probe('https://api.example.com')

    assertProbeResult(result, {
      tier: 'free',
      rateLimitsNull: true,
    })
  })

  // ── 3. Free 200 with retry-after header ─────────────────────────────

  it('classifies 200 with retry-after as free with retryAfter', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 200,
        headers: { 'retry-after': '30' },
      }),
    })

    const result = await probe.probe('https://api.example.com')

    assertProbeResult(result, {
      tier: 'free',
      retryAfter: 30,
    })
  })

  // ── 4. Paid 401 with payment_required body ──────────────────────────

  it('classifies 401 with payment_required body as paid', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { code: 'payment_required', message: 'Payment required' } }),
      }),
    })

    const result = await probe.probe('https://api.openai.com', 'sk-test')

    assertProbeResult(result, { tier: 'paid', rateLimitsNull: true })
  })

  // ── 5. Paid 403 with payment_required body ──────────────────────────

  it('classifies 403 with payment_required body as paid', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { code: 'payment_required' } }),
      }),
    })

    const result = await probe.probe('https://api.anthropic.com', 'sk-test')

    assertProbeResult(result, { tier: 'paid', rateLimitsNull: true })
  })

  // ── 6. Exhausted 429 with remaining=0 ──────────────────────────────

  it('classifies 429 with x-ratelimit-remaining-requests=0 as free_but_exhausted', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 429,
        headers: {
          'x-ratelimit-remaining-requests': '0',
          'retry-after': '60',
        },
      }),
    })

    const result = await probe.probe('https://api.groq.com/openai')

    assertProbeResult(result, {
      tier: 'free_but_exhausted',
      requestsRemaining: 0,
      retryAfter: 60,
    })
  })

  // ── 7. Exhausted 429 with retry-after ──────────────────────────────

  it('classifies 429 with retry-after as free_but_exhausted', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 429,
        headers: { 'retry-after': '60' },
      }),
    })

    const result = await probe.probe('https://api.example.com')

    assertProbeResult(result, {
      tier: 'free_but_exhausted',
      retryAfter: 60,
    })
  })

  // ── 8. Connection error ────────────────────────────────────────────

  it('classifies connection error as unknown with error message', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetchError(new Error('fetch failed: connect ECONNREFUSED')),
    })

    const result = await probe.probe('https://invalid.example.com')

    assertProbeResult(result, {
      tier: 'unknown',
      rateLimitsNull: true,
      errorContains: 'fetch failed',
    })
  })

  // ── 9. Timeout ──────────────────────────────────────────────────────

  it('classifies timeout (AbortError) as unknown with timeout message', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    const probe = new TierProbe({
      httpFetch: mockFetchError(abortError),
    })

    const result = await probe.probe('https://slow.example.com')

    assertProbeResult(result, {
      tier: 'unknown',
      rateLimitsNull: true,
      errorContains: 'timeout',
    })
  })

  // ── 10. Malformed 401 (non-JSON, no payment_required) ─────────────

  it('classifies 401 without payment_required body as unknown', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 401,
        body: '<html>Unauthorized</html>',
      }),
    })

    const result = await probe.probe('https://api.example.com', 'sk-bad')

    assertProbeResult(result, {
      tier: 'unknown',
      rateLimitsNull: true,
      errorContains: 'without payment_required',
    })
  })

  // ── 11. 5xx server error ──────────────────────────────────────────

  it('classifies 5xx server error as unknown', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({ status: 502 }),
    })

    const result = await probe.probe('https://api.example.com')

    assertProbeResult(result, {
      tier: 'unknown',
      rateLimitsNull: true,
      errorContains: '502',
    })
  })

  // ── 12. Other 4xx (400 Bad Request) ─────────────────────────────────

  it('classifies other 4xx (400) as unknown', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({ status: 400 }),
    })

    const result = await probe.probe('https://api.example.com')

    assertProbeResult(result, {
      tier: 'unknown',
      rateLimitsNull: true,
      errorContains: '400',
    })
  })

  // ── 13. API key is forwarded as Authorization header ────────────────

  it('sends Authorization header when apiKey is provided', async () => {
    let capturedAuth: string | undefined
    const fetchWithCapture: typeof globalThis.fetch = async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined
      capturedAuth = headers?.authorization
      return new Response('', { status: 200 }) as Response
    }

    const probe = new TierProbe({ httpFetch: fetchWithCapture })
    await probe.probe('https://api.openai.com', 'sk-secret-123')

    assert.equal(capturedAuth, 'Bearer sk-secret-123')
  })

  it('does not send Authorization header when apiKey is omitted', async () => {
    let capturedAuth: string | undefined
    const fetchWithCapture: typeof globalThis.fetch = async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined
      capturedAuth = headers?.authorization
      return new Response('', { status: 200 }) as Response
    }

    const probe = new TierProbe({ httpFetch: fetchWithCapture })
    await probe.probe('https://api.groq.com/openai')

    assert.equal(capturedAuth, undefined)
  })

  // ── 14. Request URL is correct ──────────────────────────────────────

  it('probes ${url}/v1/models', async () => {
    let capturedUrl: string | undefined
    const fetchWithCapture: typeof globalThis.fetch = async (url) => {
      capturedUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      return new Response('', { status: 200 }) as Response
    }

    const probe = new TierProbe({ httpFetch: fetchWithCapture })
    await probe.probe('https://api.groq.com/openai')

    assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/models')
  })

  // ── 15. 200 with only tokens header ─────────────────────────────────

  it('classifies 200 with only x-ratelimit-remaining-tokens as free', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 200,
        headers: { 'x-ratelimit-remaining-tokens': '99999' },
      }),
    })

    const result = await probe.probe('https://api.example.com')

    assertProbeResult(result, {
      tier: 'free',
      tokensRemaining: 99999,
    })
  })

  // ── 16. Telemetry emission ─────────────────────────────────────────

  it('emits TIER_PROBE_SUCCESS for free classification', async () => {
    const events: Array<{ eventClass: string; payload: Record<string, unknown> }> = []
    const telemetryDeps = {
      trigger: async (_target: string, _fn: string, input: unknown) => {
        const data = input as { eventClass: string; payload: Record<string, unknown> }
        events.push({ eventClass: data.eventClass, payload: data.payload })
      },
    }

    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 200,
        headers: { 'x-ratelimit-remaining-requests': '500' },
      }),
      telemetryDeps,
    })

    await probe.probe('https://api.groq.com/openai')

    const successEvents = events.filter(e => e.eventClass === 'TIER_PROBE_SUCCESS')
    assert.equal(successEvents.length, 1, 'should emit 1 TIER_PROBE_SUCCESS')
  })

  it('emits TIER_PROBE_EXHAUSTED for free_but_exhausted', async () => {
    const events: Array<{ eventClass: string }> = []
    const telemetryDeps = {
      trigger: async (_target: string, _fn: string, input: unknown) => {
        const data = input as { eventClass: string }
        events.push(data)
      },
    }

    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 429,
        headers: { 'x-ratelimit-remaining-requests': '0' },
      }),
      telemetryDeps,
    })

    await probe.probe('https://api.groq.com/openai')

    const exhaustedEvents = events.filter(e => e.eventClass === 'TIER_PROBE_EXHAUSTED')
    assert.equal(exhaustedEvents.length, 1, 'should emit 1 TIER_PROBE_EXHAUSTED')
  })

  it('emits TIER_PROBE_FAILED for unknown classification', async () => {
    const events: Array<{ eventClass: string }> = []
    const telemetryDeps = {
      trigger: async (_target: string, _fn: string, input: unknown) => {
        const data = input as { eventClass: string }
        events.push(data)
      },
    }

    const probe = new TierProbe({
      httpFetch: mockFetch({ status: 500 }),
      telemetryDeps,
    })

    await probe.probe('https://api.example.com')

    const failedEvents = events.filter(e => e.eventClass === 'TIER_PROBE_FAILED')
    assert.equal(failedEvents.length, 1, 'should emit 1 TIER_PROBE_FAILED')
  })

  // ── 17. Integer header parsing handles invalid values ───────────────

  it('handles non-numeric rate-limit header values gracefully', async () => {
    const probe = new TierProbe({
      httpFetch: mockFetch({
        status: 200,
        headers: {
          'x-ratelimit-remaining-requests': 'not-a-number',
          'x-ratelimit-remaining-tokens': '',
        },
      }),
    })

    const result = await probe.probe('https://api.example.com')

    // Non-numeric headers should be ignored — no rate-limits parsed means unlimited free
    assertProbeResult(result, { tier: 'free', rateLimitsNull: true })
  })

  // ── 18. Default timeout is applied ──────────────────────────────────

  it('uses default 5000ms timeout', () => {
    const probe = new TierProbe()
    assert.equal((probe as unknown as { timeoutMs: number }).timeoutMs, 5000)
  })

  it('accepts custom timeout', () => {
    const probe = new TierProbe({ timeoutMs: 10000 })
    assert.equal((probe as unknown as { timeoutMs: number }).timeoutMs, 10000)
  })
})
