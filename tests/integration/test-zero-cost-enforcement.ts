/**
 * test-zero-cost-enforcement — End-to-end integration test for zero-cost enforcement.
 *
 * Exercises the complete zero-cost enforcement pipeline:
 *   - UsageTracker with SQLite-backed free-tier limit tracking
 *   - ZeroCostCircuitBreaker that gates free-tier exhaustion and refuses paid tier
 *   - FailoverEngine integration that falls through exhausted/delined providers
 *   - QuotaMonitor with threshold-based QUOTA_ALERT (80% default)
 *   - Telemetry events: TIER_REFUSED, QUOTA_EXHAUSTED, COST_ENFORCED,
 *     QUOTA_CHECK, QUOTA_ALERT
 *
 * Test scenario:
 *   - 3 mock providers: groq (free, limit 10), cerebras (free, limit 100),
 *     openai (paid, always refused in zero-cost mode)
 *   - 25 requests: first 2 exhaust groq (after 8 pre-recorded for alert),
 *     remaining 23 fall through to cerebras
 *   - All 25 succeed — zero-cost guarantee preserved
 *
 * Run: npx tsx tests/integration/test-zero-cost-enforcement.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { UsageTracker } from '../../workers/gateway/src/zero-cost/usage_tracker.ts'
import { ZeroCostCircuitBreaker } from '../../workers/gateway/src/zero-cost/circuit_breaker.ts'
import { TierClassifier } from '../../workers/gateway/src/zero-cost/tier_classifier.ts'
import { QuotaMonitor } from '../../workers/gateway/src/zero-cost/quota_monitor.ts'
import { FailoverEngine } from '../../workers/gateway/src/failover.ts'
import type { TelemetryDeps } from '../../workers/shared/telemetry.ts'

// ── Types ──────────────────────────────────────────────────────────────

interface TelemetryEntry {
  eventClass: string
  payload: Record<string, unknown>
}

// ── Helpers ────────────────────────────────────────────────────────────

function createTelemetryCapture(): {
  events: TelemetryEntry[]
  deps: TelemetryDeps
} {
  const events: TelemetryEntry[] = []
  const deps: TelemetryDeps = {
    trigger: async (_target: string, _fnName: string, input: unknown) => {
      const data = input as { eventClass: string; payload: Record<string, unknown> }
      events.push({ eventClass: data.eventClass, payload: data.payload })
    },
  }
  return { events, deps }
}

/**
 * Mock provider config for all test providers.
 */
function mockGetProviderConfig(providerId: string): { baseUrl: string; envKey: string } | undefined {
  const configs: Record<string, { baseUrl: string; envKey: string }> = {
    groq: { baseUrl: 'https://api.groq.com/openai/v1/chat/completions', envKey: 'GROQ_API_KEY' },
    cerebras: { baseUrl: 'https://api.cerebras.ai/v1/chat/completions', envKey: 'CEREBRAS_API_KEY' },
    openai: { baseUrl: 'https://api.openai.com/v1/chat/completions', envKey: 'OPENAI_API_KEY' },
  }
  return configs[providerId]
}

const TEST_MESSAGES = [{ role: 'user' as const, content: 'hello' }]

// ── Tests ──────────────────────────────────────────────────────────────

describe('Zero-Cost Enforcement Integration', () => {
  let usageTracker: UsageTracker
  let telemetry: ReturnType<typeof createTelemetryCapture>
  let circuitBreaker: ZeroCostCircuitBreaker
  let providerCallCount: Record<string, number>

  before(() => {
    process.env.GATEWAY_QUOTA_MONITORING = 'true'
  })

  after(() => {
    delete process.env.GATEWAY_QUOTA_MONITORING
    if (usageTracker) usageTracker.close()
  })

  // ── (a) + (c) + (d) + (f): Main enforcement flow ─────────────────

  it('(a)+(c)+(d)+(f): 25 requests enforce zero-cost, track usage, fire events, report quota', async () => {
    // ── 1. Setup ─────────────────────────────────────────────────
    usageTracker = new UsageTracker(':memory:')
    usageTracker.setFreeTierLimit('groq', 10)
    usageTracker.setFreeTierLimit('cerebras', 100)

    // Pre-record 8 entries for groq so the 80% quota-alert threshold
    // is crossed when the monitor starts. This avoids timing-dependent
    // interval-based alert detection.
    for (let i = 0; i < 8; i++) {
      usageTracker.record('groq', 'groq', 10)
    }

    telemetry = createTelemetryCapture()
    circuitBreaker = new ZeroCostCircuitBreaker(usageTracker, telemetry.deps)

    providerCallCount = { groq: 0, cerebras: 0, openai: 0 }

    // ── 2. QuotaMonitor (for QUOTA_ALERT) ─────────────────────────
    const quotaMonitor = new QuotaMonitor(usageTracker, 0.8, 60000, telemetry.deps)
    quotaMonitor._resetAlertCooldowns()

    // start() runs checkThresholds() immediately → groq at 8/10 = 80% → QUOTA_ALERT fires
    quotaMonitor.start()

    // Verify the alert fired synchronously
    const quotaAlert = telemetry.events.find((e) => e.eventClass === 'QUOTA_ALERT')
    // We'll assert this in the (e) section below

    // ── 3. Wire FailoverEngine with circuit breaker ───────────────
    const mockCallProvider = async (
      config: { baseUrl: string },
      _apiKey: string,
      _model: string,
    ) => {
      // Determine which provider by matching baseUrl
      const provider = Object.keys(providerCallCount).find((p) =>
        config.baseUrl.includes(p),
      )!
      providerCallCount[provider]++
      // Record usage so subsequent circuit-breaker checks see the updated count
      usageTracker.record(provider, provider, 10)

      return {
        id: 'r-1',
        content: `response from ${provider}`,
        finishReason: 'stop' as const,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }
    }

    const engine = new FailoverEngine(
      async (_providerId: string) => 'sk-test-key',
      mockCallProvider as any,
      mockGetProviderConfig,
      circuitBreaker,
    )

    // ── 4. Fire 25 requests ───────────────────────────────────────
    for (let i = 0; i < 25; i++) {
      const result = await engine.routeWithFailover(
        ['groq/gpt-4', 'cerebras/gpt-4', 'openai/gpt-4'],
        'gpt-4',
        TEST_MESSAGES as any,
      )
      assert.equal(
        result.success,
        true,
        `Request ${i + 1} should succeed — got: ${(result as any).message ?? 'ok'}`,
      )
    }

    quotaMonitor.stop()

    // ── 5. Assertions ─────────────────────────────────────────────

    // (a) Zero-cost enforcement: groq exhausted, cerebras fallback, openai refused
    assert.equal(
      providerCallCount.groq,
      2,
      'groq handled 2 requests before exhaustion (8 pre-recorded + 2 from test = 10)',
    )
    assert.equal(
      providerCallCount.cerebras,
      23,
      'cerebras handled remaining 23 requests',
    )
    assert.equal(
      providerCallCount.openai,
      0,
      'openai was never reached (zero-cost enforcement)',
    )

    // (c) QUOTA_EXHAUSTED fires when groq hits 10/10
    const exhaustedEvents = telemetry.events.filter(
      (e) => e.eventClass === 'QUOTA_EXHAUSTED',
    )
    assert.ok(
      exhaustedEvents.length >= 1,
      `QUOTA_EXHAUSTED event fires for groq (got ${exhaustedEvents.length})`,
    )
    const firstExhausted = exhaustedEvents[0]
    assert.equal(firstExhausted.payload.provider, 'groq')
    // The pre-records set up 8 requests. During the test, the first 2 requests
    // to groq are allowed (COST_ENFORCED — bringing the count to 9 and 10).
    // The 3rd request (and every subsequent one) triggers a groq circuit-breaker
    // check that sees current=10 → utilization_pct=1.0 → QUOTA_EXHAUSTED.
    // So current=10 (not 8) on the first QUOTA_EXHAUSTED.
    assert.equal(firstExhausted.payload.current, 10, 'QUOTA_EXHAUSTED fires at 10/10')

    // (d) COST_ENFORCED fires for each allowed free-tier request
    const costEnforced = telemetry.events.filter(
      (e) => e.eventClass === 'COST_ENFORCED',
    )
    // 25 requests: each goes through circuit breaker check.
    // First 2 go to groq → COST_ENFORCED for groq (requests 9, 10 excluding pre-records)
    // Next 23 go to cerebras → COST_ENFORCED for cerebras
    // Total COST_ENFORCED = 25 (one per successful request)
    assert.ok(
      costEnforced.length >= 25,
      `COST_ENFORCED fires at least 25 times (got ${costEnforced.length})`,
    )

    // QUOTA_CHECK fires on every circuit-breaker check
    const quotaChecks = telemetry.events.filter(
      (e) => e.eventClass === 'QUOTA_CHECK',
    )
    // 25 requests × groq check + 23 requests × cerebras check = 48 checks minimum
    // (openai never checked because cerebras always has capacity)
    assert.ok(
      quotaChecks.length >= 40,
      `QUOTA_CHECK fires at least 40 times (got ${quotaChecks.length})`,
    )

    // (f) GET /v1/admin/quota returns accurate per-provider utilization
    const monitor = new QuotaMonitor(usageTracker)
    const status = monitor.getStatus()

    const groqStatus = status.providers.find((p) => p.name === 'groq')
    assert.ok(groqStatus, 'groq is in quota status')
    assert.equal(groqStatus.current, 10, 'groq current is 10')
    assert.equal(groqStatus.limit, 10, 'groq limit is 10')
    assert.equal(groqStatus.utilization_pct, 100, 'groq utilization is 100%')

    const cerebrasStatus = status.providers.find((p) => p.name === 'cerebras')
    assert.ok(cerebrasStatus, 'cerebras is in quota status')
    assert.equal(cerebrasStatus.current, 23, 'cerebras current is 23')
    assert.equal(cerebrasStatus.limit, 100, 'cerebras limit is 100')
    assert.equal(cerebrasStatus.utilization_pct, 23, 'cerebras utilization is 23%')

    const togetherStatus = status.providers.find((p) => p.name === 'together')
    assert.ok(togetherStatus, 'together is in quota status (known provider)')
    assert.equal(togetherStatus.current, 0, 'together has no usage')
    assert.equal(togetherStatus.limit, 1000, 'together defaults to limit 1000 when not configured')
  })

  // ── (b) TIER_REFUSED for paid providers ──────────────────────────

  it('(b) TIER_REFUSED event fires for paid provider (openai)', async () => {
    // TierClassifier directly
    assert.equal(
      TierClassifier.classify('openai'),
      'paid',
      'openai is classified as paid',
    )
    assert.equal(
      TierClassifier.classify('groq'),
      'free',
      'groq is classified as free',
    )

    // Circuit breaker emits TIER_REFUSED
    const cap = createTelemetryCapture()
    const cb = new ZeroCostCircuitBreaker(usageTracker, cap.deps)

    const result = await cb.check('test-key', 'openai')
    assert.equal(result.allowed, false, 'openai is not allowed')
    assert.equal(result.reason, 'paid_tier', 'openai refused as paid_tier')

    const tierRefused = cap.events.find((e) => e.eventClass === 'TIER_REFUSED')
    assert.ok(tierRefused, 'TIER_REFUSED event fires')
    assert.equal(tierRefused.payload.provider, 'openai')
    assert.equal(tierRefused.payload.tier, 'paid')

    const quotaCheck = cap.events.find((e) => e.eventClass === 'QUOTA_CHECK')
    assert.ok(quotaCheck, 'QUOTA_CHECK event also fires alongside TIER_REFUSED')
    assert.equal(quotaCheck.payload.allowed, false)
  })

  // ── (e) QUOTA_ALERT at 80% threshold ────────────────────────────

  it('(e) QUOTA_ALERT fires at 80% threshold for groq', async () => {
    // Fresh tracker with exactly 8/10 entries for groq
    const tracker = new UsageTracker(':memory:')
    tracker.setFreeTierLimit('groq', 10)
    for (let i = 0; i < 8; i++) {
      tracker.record('groq', 'groq', 10)
    }

    const cap = createTelemetryCapture()
    const monitor = new QuotaMonitor(tracker, 0.8, 60000, cap.deps)

    // Start monitor — immediately calls checkThresholds()
    monitor.start()

    const alert = cap.events.find((e) => e.eventClass === 'QUOTA_ALERT')
    assert.ok(alert, 'QUOTA_ALERT event fires')
    assert.equal(alert.payload.provider, 'groq', 'QUOTA_ALERT is for groq')
    assert.equal(
      alert.payload.currentUsage,
      8,
      'groq has 8 requests at 80% threshold',
    )
    assert.equal(alert.payload.limit, 10, 'groq limit is 10')
    assert.equal(
      alert.payload.utilizationPct,
      80,
      'groq at 80% utilization',
    )
    assert.equal(alert.payload.threshold, 0.8, 'threshold is 0.8')

    monitor.stop()
    tracker.close()
  })

  // ── (g) All 5 event types fire ──────────────────────────────────

  it('(g) all 5 expected telemetry event types fire across the test', async () => {
    // Collect events from the main test flow + TIER_REFUSED test
    const allEventClasses = new Set(telemetry.events.map((e) => e.eventClass))

    // The TIER_REFUSED test uses its own capture — add its event to the set
    // by running a quick assertion we already verified above
    const cap = createTelemetryCapture()
    const cb = new ZeroCostCircuitBreaker(usageTracker, cap.deps)
    await cb.check('test-key', 'openai')
    cap.events.forEach((e) => allEventClasses.add(e.eventClass))

    const expected = [
      'COST_ENFORCED',
      'QUOTA_CHECK',
      'QUOTA_EXHAUSTED',
      'TIER_REFUSED',
      'QUOTA_ALERT',
    ]

    for (const evt of expected) {
      assert.ok(
        allEventClasses.has(evt),
        `${evt} event must fire across all tests`,
      )
    }
  })
})
