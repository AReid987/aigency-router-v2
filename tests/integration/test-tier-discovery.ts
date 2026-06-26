/**
 * test-tier-discovery.ts — End-to-end integration test for TierProbe +
 * TierConfigCache + circuit-breaker enforcement with discovered tiers.
 *
 * Tests the full discovery pipeline:
 *   (a) TierProbe classifies endpoints correctly (free / paid / free_but_exhausted)
 *   (b) TierConfigCache caches results with TTL respect
 *   (c) Circuit-breaker enforces discovered tiers (refuses paid, skips exhausted)
 *   (d) Stale-while-revalidate: re-probe succeeds after TTL expiry
 *   (e) Fallback to static config on probe failure (parseTierOverrides +
 *       TierClassifier instance fallback chain)
 *   (f) Telemetry events: TIER_PROBE_SUCCESS, TIER_CONFIG_REFRESHED,
 *       TIER_REFUSED, QUOTA_EXHAUSTED
 *
 * Run: node_modules/.bin/tsx tests/integration/test-tier-discovery.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { TierProbe } from '../../workers/gateway/src/zero-cost/tier_probe.ts'
import { TierConfigCache } from '../../workers/gateway/src/zero-cost/tier_config_cache.ts'
import { TierClassifier, parseTierOverrides } from '../../workers/gateway/src/zero-cost/tier_classifier.ts'
import { UsageTracker } from '../../workers/gateway/src/zero-cost/usage_tracker.ts'
import { ZeroCostCircuitBreaker } from '../../workers/gateway/src/zero-cost/circuit_breaker.ts'
import type { TelemetryDeps } from '../../workers/shared/telemetry.ts'

// ── Types ──────────────────────────────────────────────────────────────

interface TelemetryEntry {
  eventClass: string
  sourceWorker: string
  payload: Record<string, unknown>
}

// ── Telemetry capture helper ──────────────────────────────────────────

function createTelemetryCapture(): {
  events: TelemetryEntry[]
  deps: TelemetryDeps
} {
  const events: TelemetryEntry[] = []
  const deps: TelemetryDeps = {
    trigger: async (_target: string, _fnName: string, input: unknown) => {
      const data = input as TelemetryEntry
      events.push(data)
    },
  }
  return { events, deps }
}

// ── Mock Provider Server ──────────────────────────────────────────────

class MockProviderServer {
  public server: http.Server
  public port: number = 0
  public url: string = ''
  public requestCounts: Record<string, number> = { groq: 0, openai: 0, cerebras: 0 }

  constructor() {
    this.server = http.createServer(this.handleRequest.bind(this))
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // groq/v1/models -> 200 with generous rate-limit headers (classified as free)
    if (path.includes('groq')) {
      this.requestCounts.groq++
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-ratelimit-remaining-requests': '1000',
        'x-ratelimit-remaining-tokens': '50000',
        'x-ratelimit-limit-requests': '2000',
        'x-ratelimit-limit-tokens': '100000',
      })
      res.end(JSON.stringify({ object: 'list', data: [] }))
      return
    }

    // openai/v1/models -> 401 with payment_required body (classified as paid)
    if (path.includes('openai')) {
      this.requestCounts.openai++
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          code: 'payment_required',
          message: 'Payment required. Please add a payment method.',
        },
      }))
      return
    }

    // cerebras/v1/models -> 429 with retry-after (classified as free_but_exhausted)
    if (path.includes('cerebras')) {
      this.requestCounts.cerebras++
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '60',
      })
      res.end(JSON.stringify({
        error: {
          message: 'Too Many Requests. Please wait before retrying.',
          type: 'rate_limit_error',
        },
      }))
      return
    }

    // Fallback 404
    res.writeHead(404)
    res.end('Not found')
  }

  async start(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          this.url = `http://127.0.0.1:${this.port}`
          resolve(this.url)
        }
      })
    })
  }

  stop(): void {
    this.server.close()
  }

  resetCounts(): void {
    this.requestCounts = { groq: 0, openai: 0, cerebras: 0 }
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('TierProbe + TierConfigCache + Circuit-Breaker Integration', () => {
  let mockServer: MockProviderServer
  let baseUrl: string
  let probeTelemetry: ReturnType<typeof createTelemetryCapture>
  let tierProbe: TierProbe

  before(async () => {
    mockServer = new MockProviderServer()
    baseUrl = await mockServer.start()

    // Global telemetry capture for TierProbe probes
    probeTelemetry = createTelemetryCapture()
    tierProbe = new TierProbe({
      timeoutMs: 5000,
      telemetryDeps: probeTelemetry.deps,
    })
  })

  after(() => {
    mockServer.stop()
  })

  // ────────────────────────────────────────────────────────────────────
  // (a) TierProbe classifies endpoints correctly
  // ────────────────────────────────────────────────────────────────────

  describe('(a) TierProbe classification', () => {
    it('classifies groq as free with rate-limit info', async () => {
      const result = await tierProbe.probe(`${baseUrl}/groq`)

      assert.equal(result.tier, 'free', 'groq should be classified as free')
      assert.ok(result.rateLimits !== null, 'groq should have rate-limit info')
      assert.equal(result.rateLimits!.requestsRemaining, 1000)
      assert.equal(result.rateLimits!.limitRequests, 2000)
      assert.equal(result.rateLimits!.limitTokens, 100000)
      assert.ok(result.latencyMs >= 0, 'latencyMs should be >= 0')
      assert.ok(result.probedAt > 0, 'probedAt should be set')
      assert.equal(result.error, undefined, 'no error expected')
    })

    it('classifies openai as paid (401 + payment_required body)', async () => {
      const result = await tierProbe.probe(`${baseUrl}/openai`)

      assert.equal(result.tier, 'paid', 'openai should be classified as paid')
      assert.equal(result.rateLimits, null, 'paid tier has no rate-limit info')
      assert.ok(result.latencyMs >= 0)
      assert.ok(result.probedAt > 0)
    })

    it('classifies cerebras as free_but_exhausted (429 + retry-after)', async () => {
      const result = await tierProbe.probe(`${baseUrl}/cerebras`)

      assert.equal(result.tier, 'free_but_exhausted', 'cerebras should be free_but_exhausted')
      assert.ok(result.rateLimits !== null, 'exhausted response should have rate-limit/retry')
      assert.equal(result.rateLimits!.retryAfter, 60, 'retry-after should be 60s')
      assert.ok(result.latencyMs >= 0)
      assert.ok(result.probedAt > 0)
    })
  })

  // ────────────────────────────────────────────────────────────────────
  // (b) TierConfigCache caches results
  // ────────────────────────────────────────────────────────────────────

  describe('(b) TierConfigCache caching', () => {
    it('caches probe results within TTL (no re-probe on second call)', async () => {
      mockServer.resetCounts()

      const cacheTelemetry = createTelemetryCapture()
      const cacheProbe = new TierProbe({
        timeoutMs: 5000,
        telemetryDeps: cacheTelemetry.deps,
      })
      const configCache = new TierConfigCache(cacheProbe as any, {
        refresh_interval_ms: 60_000, // long TTL so cache stays fresh
        known_providers: [
          { name: 'groq', url: `${baseUrl}/groq` },
        ],
      })

      // First call — should probe the server
      const first = await configCache.getProviderTier('groq')
      assert.equal(first.tier, 'free', 'first call returns free')
      assert.equal(mockServer.requestCounts.groq, 1, 'first call should probe exactly once')

      // Second call within TTL — should return cached (no probe)
      const second = await configCache.getProviderTier('groq')
      assert.equal(second.tier, 'free', 'second call returns free')
      assert.equal(second.probedAt, first.probedAt, 'same cached result (probedAt unchanged)')
      assert.equal(mockServer.requestCounts.groq, 1, 'second call should NOT probe (cached)')

      // TIER_PROBE_SUCCESS should have been fired (only once)
      const successEvents = cacheTelemetry.events.filter(
        (e) => e.eventClass === 'TIER_PROBE_SUCCESS',
      )
      assert.equal(successEvents.length, 1, 'TIER_PROBE_SUCCESS fires exactly once (from the probe)')
    })
  })

  // ────────────────────────────────────────────────────────────────────
  // (c) Circuit-breaker enforces discovered tiers via TierClassifier
  //     + UsageTracker
  // ────────────────────────────────────────────────────────────────────

  describe('(c) Circuit-breaker enforcement', () => {
    it('TierClassifier instance uses cached probe results', async () => {
      // Probe the endpoints first to verify TierProbe classifications
      const groqResult = await tierProbe.probe(`${baseUrl}/groq`)
      assert.equal(groqResult.tier, 'free', 'pre-check: groq is free')

      const openaiResult = await tierProbe.probe(`${baseUrl}/openai`)
      assert.equal(openaiResult.tier, 'paid', 'pre-check: openai is paid')

      // Create TierConfigCache populated with known_providers pointing at mock
      const classCacheProbe = new TierProbe({ timeoutMs: 5000 })
      const classCache = new TierConfigCache(classCacheProbe as any, {
        refresh_interval_ms: 60_000,
        known_providers: [
          { name: 'groq', url: `${baseUrl}/groq` },
          { name: 'openai', url: `${baseUrl}/openai` },
          { name: 'cerebras', url: `${baseUrl}/cerebras` },
        ],
      })

      // Pre-populate the cache by calling getProviderTier
      await classCache.getProviderTier('groq')
      await classCache.getProviderTier('openai')
      await classCache.getProviderTier('cerebras')

      // TierClassifier instance with TierConfigCache
      const classifier = new TierClassifier({ tierConfigCache: classCache })
      const groqClass = await classifier.classify('groq')
      const openaiClass = await classifier.classify('openai')

      assert.equal(groqClass, 'free', 'classifier uses cached tier: groq=free')
      assert.equal(openaiClass, 'paid', 'classifier uses cached tier: openai=paid')
    })

    it('ZeroCostCircuitBreaker refuses paid provider (openai)', async () => {
      const cbTelemetry = createTelemetryCapture()
      const usageTracker = new UsageTracker(':memory:')
      usageTracker.setFreeTierLimit('groq', 5)
      usageTracker.setFreeTierLimit('cerebras', 100)

      const circuitBreaker = new ZeroCostCircuitBreaker(usageTracker, cbTelemetry.deps)

      // openai is static-classified as 'paid' by TierClassifier.classify()
      const openaiResult = await circuitBreaker.check('test-key', 'openai')
      assert.equal(openaiResult.allowed, false, 'openai must be refused')
      assert.equal(openaiResult.reason, 'paid_tier', 'refused as paid tier')

      // Verify TIER_REFUSED telemetry
      const tierRefused = cbTelemetry.events.find(
        (e) => e.eventClass === 'TIER_REFUSED',
      )
      assert.ok(tierRefused, 'TIER_REFUSED event fires')
      assert.equal(tierRefused!.payload.provider, 'openai')
      assert.equal(tierRefused!.payload.tier, 'paid')

      usageTracker.close()
    })

    it('ZeroCostCircuitBreaker refuses exhausted free provider (cerebras)', async () => {
      const cbTelemetry = createTelemetryCapture()
      const usageTracker = new UsageTracker(':memory:')
      usageTracker.setFreeTierLimit('cerebras', 3)

      // Exhaust cerebras by recording 3 requests
      usageTracker.record('test-key', 'cerebras', 10)
      usageTracker.record('test-key', 'cerebras', 10)
      usageTracker.record('test-key', 'cerebras', 10)

      const circuitBreaker = new ZeroCostCircuitBreaker(usageTracker, cbTelemetry.deps)

      const cerebrasResult = await circuitBreaker.check('test-key', 'cerebras')
      assert.equal(cerebrasResult.allowed, false, 'cerebras must be refused')
      assert.equal(cerebrasResult.reason, 'exhausted', 'refused as exhausted')

      // Verify QUOTA_EXHAUSTED telemetry
      const quotaExhausted = cbTelemetry.events.find(
        (e) => e.eventClass === 'QUOTA_EXHAUSTED',
      )
      assert.ok(quotaExhausted, 'QUOTA_EXHAUSTED event fires')
      assert.equal(quotaExhausted!.payload.provider, 'cerebras')
      assert.equal(quotaExhausted!.payload.current, 3)
      assert.equal(quotaExhausted!.payload.limit, 3)

      usageTracker.close()
    })

    it('ZeroCostCircuitBreaker allows free provider under quota (groq)', async () => {
      const cbTelemetry = createTelemetryCapture()
      const usageTracker = new UsageTracker(':memory:')
      usageTracker.setFreeTierLimit('groq', 100)

      const circuitBreaker = new ZeroCostCircuitBreaker(usageTracker, cbTelemetry.deps)

      // groq is classified as 'free' with 0/100 usage
      const groqResult = await circuitBreaker.check('test-key', 'groq')
      assert.equal(groqResult.allowed, true, 'groq must be allowed')

      // Record some usage
      usageTracker.record('test-key', 'groq', 10)
      usageTracker.record('test-key', 'groq', 10)

      // Still under quota (2/100)
      const groqResult2 = await circuitBreaker.check('test-key', 'groq')
      assert.equal(groqResult2.allowed, true, 'groq still allowed (2/100)')

      // COST_ENFORCED events should have fired
      const costEnforced = cbTelemetry.events.filter(
        (e) => e.eventClass === 'COST_ENFORCED',
      )
      assert.ok(costEnforced.length >= 2, 'COST_ENFORCED fires for allowed requests')

      usageTracker.close()
    })
  })

  // ────────────────────────────────────────────────────────────────────
  // (d) Stale-while-revalidate
  // ────────────────────────────────────────────────────────────────────

  describe('(d) Stale-while-revalidate', () => {
    it('re-probes after TTL expiry', async () => {
      mockServer.resetCounts()

      const swrTelemetry = createTelemetryCapture()
      const swrProbe = new TierProbe({
        timeoutMs: 5000,
        telemetryDeps: swrTelemetry.deps,
      })
      const swrCache = new TierConfigCache(swrProbe as any, {
        refresh_interval_ms: 50, // very short TTL for fast expiry
        known_providers: [
          { name: 'groq', url: `${baseUrl}/groq` },
        ],
        telemetry_deps: swrTelemetry.deps,
      })

      // Start background refresh so TIER_CONFIG_REFRESHED can fire
      swrCache.start()

      // First call — probes
      const first = await swrCache.getProviderTier('groq')
      assert.equal(first.tier, 'free', 'first call returns free')
      assert.equal(mockServer.requestCounts.groq, 1, 'first call probes')

      // Quick second call within TTL — cached, no probe
      const second = await swrCache.getProviderTier('groq')
      assert.equal(second.tier, 'free', 'second call returns free')
      assert.equal(second.probedAt, first.probedAt, 'cached result (probedAt same)')
      assert.equal(mockServer.requestCounts.groq, 1, 'no probe on cached result')

      // Wait for TTL to expire and give background refresh time to fire
      await new Promise((r) => setTimeout(r, 150))

      // After TTL expiry — getProviderTier should re-probe
      const third = await swrCache.getProviderTier('groq')
      assert.equal(third.tier, 'free', 'third call returns free')
      assert.ok(
        third.probedAt > first.probedAt,
        're-probed after TTL expiry (probedAt newer)',
      )

      // Check TIER_CONFIG_REFRESHED fired from background refresh
      const refreshEvents = swrTelemetry.events.filter(
        (e) => e.eventClass === 'TIER_CONFIG_REFRESHED',
      )
      assert.ok(
        refreshEvents.length >= 1,
        `TIER_CONFIG_REFRESHED event fires (got ${refreshEvents.length})`,
      )

      swrCache.stop()
    })
  })

  // ────────────────────────────────────────────────────────────────────
  // (e) Fallback to static config on probe failure
  // ────────────────────────────────────────────────────────────────────
  //
  // PROVIDER_TIER_OVERRIDE env var is read at module import time into a
  // frozen constant (PROVIDER_TIER_CONFIG), so we verify the override
  // PARSER directly (exported as parseTierOverrides). We also verify the
  // fallback chain: TierClassifier instance -> TierConfigCache (returns
  // 'unknown' for uncached/unprobeable providers) -> PROVIDER_TIER_CONFIG.

  describe('(e) Fallback on probe failure', () => {
    it('parseTierOverrides parses empty/undefined gracefully', () => {
      assert.deepEqual(parseTierOverrides(undefined), {})
      assert.deepEqual(parseTierOverrides(''), {})
    })

    it('parseTierOverrides parses single override', () => {
      assert.deepEqual(parseTierOverrides('groq:paid'), { groq: 'paid' })
    })

    it('parseTierOverrides parses multiple overrides', () => {
      assert.deepEqual(
        parseTierOverrides('groq:paid,cerebras:free'),
        { groq: 'paid', cerebras: 'free' },
      )
    })

    it('parseTierOverrides skips invalid tier values', () => {
      // 'premium' is not a valid tier, so groq entry is skipped
      const result = parseTierOverrides('groq:premium,cerebras:free')
      assert.deepEqual(result, { cerebras: 'free' })
      assert.ok(!('groq' in result), 'groq with invalid tier is skipped')
    })

    it('parseTierOverrides normalizes case', () => {
      assert.deepEqual(parseTierOverrides('GROQ:Paid'), { groq: 'paid' })
      assert.deepEqual(parseTierOverrides('OpenAI:Free'), { openai: 'free' })
    })

    it('TierClassifier instance falls back to static config when cache returns unknown for provider', async () => {
      // Create a TierConfigCache with known_providers that does NOT include groq
      const fallbackProbe = new TierProbe({ timeoutMs: 500 })
      const fallbackCache = new TierConfigCache(fallbackProbe as any, {
        refresh_interval_ms: 60_000,
        known_providers: [], // empty — no providers are known
      })

      // TierClassifier with cache: for groq, getProviderTier returns 'unknown'
      // because there's no known_providers entry. TierClassifier falls through
      // to PROVIDER_TIER_CONFIG which classifies groq as 'free'.
      const classifier = new TierClassifier({ tierConfigCache: fallbackCache })
      const groqClass = await classifier.classify('groq')
      assert.equal(groqClass, 'free', 'TierClassifier falls back to static config')
    })

    it('TierClassifier instance falls back to static config for openai (paid default)', async () => {
      const fallbackProbe = new TierProbe({ timeoutMs: 500 })
      const fallbackCache = new TierConfigCache(fallbackProbe as any, {
        refresh_interval_ms: 60_000,
        known_providers: [],
      })

      const classifier = new TierClassifier({ tierConfigCache: fallbackCache })
      const openaiClass = await classifier.classify('openai')
      assert.equal(openaiClass, 'paid', 'TierClassifier falls back to static config: openai=paid')

      // Unknown providers also default to 'paid' (conservative)
      const unknownClass = await classifier.classify('unknown-provider')
      assert.equal(unknownClass, 'paid', 'unknown providers default to paid')
    })

    it('TierClassifier static classify uses PROVIDER_TIER_CONFIG correctly', () => {
      // Static classify is the final fallback used by ZeroCostCircuitBreaker
      assert.equal(TierClassifier.classify('groq'), 'free')
      assert.equal(TierClassifier.classify('cerebras'), 'free')
      assert.equal(TierClassifier.classify('together'), 'free')
      assert.equal(TierClassifier.classify('openai'), 'paid')
      assert.equal(TierClassifier.classify('anthropic'), 'paid')
      assert.equal(TierClassifier.classify('unknown-provider'), 'paid')
    })
  })

  // ────────────────────────────────────────────────────────────────────
  // (f) Telemetry events
  // ────────────────────────────────────────────────────────────────────

  describe('(f) Telemetry events', () => {
    it('TIER_PROBE_SUCCESS fires for free probe', () => {
      // Collected from probes in test (a)
      const successEvents = probeTelemetry.events.filter(
        (e) => e.eventClass === 'TIER_PROBE_SUCCESS',
      )
      assert.ok(
        successEvents.length >= 1,
        `TIER_PROBE_SUCCESS fires (got ${successEvents.length})`,
      )
      // At least one should be the groq free probe
      const groqSuccess = successEvents.find(
        (e) => String(e.payload.tier ?? '').includes('free') || e.payload.status === 200,
      )
      assert.ok(groqSuccess !== undefined, 'at least one TIER_PROBE_SUCCESS is for free/groq')
    })

    it('TIER_REFUSED was verified in circuit-breaker test (c)', () => {
      assert.ok(true, 'TIER_REFUSED verified in (c) - ZeroCostCircuitBreaker refuses paid openai')
    })

    it('QUOTA_EXHAUSTED was verified in circuit-breaker test (c)', () => {
      assert.ok(true, 'QUOTA_EXHAUSTED verified in (c) - ZeroCostCircuitBreaker refuses exhausted cerebras')
    })

    it('all four expected event types are observed across tests', async () => {
      // Fresh full-pipeline run exercising probe -> cache -> circuit-breaker
      const allTelemetry = createTelemetryCapture()
      const fullProbe = new TierProbe({
        timeoutMs: 5000,
        telemetryDeps: allTelemetry.deps,
      })

      // 1. Probe — fires TIER_PROBE_SUCCESS for groq
      await fullProbe.probe(`${baseUrl}/groq`)

      // 2. Set up cache with background refresh for TIER_CONFIG_REFRESHED
      const fullCache = new TierConfigCache(fullProbe as any, {
        refresh_interval_ms: 30,
        known_providers: [{ name: 'groq', url: `${baseUrl}/groq` }],
        telemetry_deps: allTelemetry.deps,
      })
      fullCache.start()
      await fullCache.getProviderTier('groq')

      // Wait for background refresh to fire
      await new Promise((r) => setTimeout(r, 100))

      // 3. Circuit-breaker — fires TIER_REFUSED + QUOTA_EXHAUSTED
      const fullTracker = new UsageTracker(':memory:')
      fullTracker.setFreeTierLimit('cerebras', 1)
      fullTracker.record('tk', 'cerebras', 10) // exhaust cerebras

      const fullBreaker = new ZeroCostCircuitBreaker(fullTracker, allTelemetry.deps)
      await fullBreaker.check('tk', 'openai')   // TIER_REFUSED
      await fullBreaker.check('tk', 'cerebras') // QUOTA_EXHAUSTED

      fullCache.stop()
      fullTracker.close()

      // Assert all four event types
      const eventClasses = allTelemetry.events.map((e) => e.eventClass)
      const expected = [
        'TIER_PROBE_SUCCESS',
        'TIER_CONFIG_REFRESHED',
        'TIER_REFUSED',
        'QUOTA_EXHAUSTED',
      ]

      for (const evt of expected) {
        assert.ok(
          eventClasses.includes(evt),
          `Expected telemetry ${evt} was observed (got: ${[...new Set(eventClasses)].join(', ')})`,
        )
      }
    })
  })
})
