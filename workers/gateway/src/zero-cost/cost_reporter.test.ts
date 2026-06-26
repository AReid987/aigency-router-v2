/**
 * CostReporter unit tests.
 *
 * Uses node:test and node:assert/strict with a MockUsageTracker that
 * provides full control over returned utilization data.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IUsageTracker, ProviderUtilization, UsageRecord } from './usage_tracker.ts'
import { CostReporter } from './cost_reporter.ts'
import type { CostReport } from './cost_reporter.ts'

// ── Mock UsageTracker ──────────────────────────────────────────────────

/**
 * A controllable IUsageTracker mock for CostReporter tests.
 *
 * Supports configurable per-provider utilization data, optional
 * getRefusedCount, and a mode where a specific provider throws on
 * getAggregateProviderUtilization.
 */
class MockUsageTracker implements IUsageTracker {
  private providerData: Map<string, ProviderUtilization> = new Map()
  private refusedCounts: Map<string, number> = new Map()
  private failingProviders: Set<string> = new Set()

  /** Set the ProviderUtilization that getAggregateProviderUtilization returns. */
  setProviderUtilization(provider: string, data: ProviderUtilization): void {
    this.providerData.set(provider, data)
  }

  /** Set the refused count for getRefusedCount. */
  setRefusedCount(provider: string, count: number): void {
    this.refusedCounts.set(provider, count)
  }

  /**
   * Mark a provider so that getAggregateProviderUtilization throws,
   * simulating a missing or misconfigured tracker source.
   */
  markFailing(provider: string): void {
    this.failingProviders.add(provider)
  }

  // ── IUsageTracker implementation ──────────────────────────────────

  getAggregateProviderUtilization(provider: string): ProviderUtilization {
    if (this.failingProviders.has(provider)) {
      throw new Error(`Simulated failure for provider: ${provider}`)
    }
    const data = this.providerData.get(provider)
    if (!data) {
      return { current: 0, limit: 0, utilization_pct: 0, ratePerMinute: 0, lastUsedAt: null }
    }
    return data
  }

  // ── Optional method for refused count ─────────────────────────────

  getRefusedCount(provider: string): number {
    return this.refusedCounts.get(provider) ?? 0
  }

  // ── Unused IUsageTracker stubs (not called by CostReporter) ───────

  record(_keyId: string, _provider: string, _tokens: number): void {
    /* stub */
  }

  getUsage(_keyId: string): UsageRecord | null {
    return null
  }

  getProviderUtilization(_keyId: string, _provider: string): ProviderUtilization {
    return { current: 0, limit: 0, utilization_pct: 0, ratePerMinute: 0, lastUsedAt: null }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Capture console output into an array for assertion. */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const origLog = console.log
  const origWarn = console.warn
  console.log = (msg: string) => { lines.push(msg) }
  console.warn = (msg: string) => { lines.push(msg) }
  return {
    lines,
    restore: () => {
      console.log = origLog
      console.warn = origWarn
    },
  }
}

/** Create a ProviderUtilization value with the given fields. */
function util(
  current: number,
  limit: number,
  lastUsedAt: number | null = null,
): ProviderUtilization {
  return {
    current,
    limit,
    utilization_pct: limit > 0 ? current / limit : 0,
    ratePerMinute: 0,
    lastUsedAt,
  }
}

/** Return an epoch ms for a date string like '2026-06-20'. */
function dateMs(dateStr: string, hour = 12): number {
  return new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`).getTime()
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('CostReporter', () => {
  // ── 1. Empty data ─────────────────────────────────────────────────

  it('returns zeroed report when all providers have no usage', async () => {
    const tracker = new MockUsageTracker()
    tracker.setProviderUtilization('groq', util(0, 1000))
    tracker.setProviderUtilization('cerebras', util(0, 500))

    const costRates = new Map([['groq', 0.01], ['cerebras', 0.005]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport()

    assert.equal(report.total_requests, 0)
    assert.equal(report.free_tier_requests, 0)
    assert.equal(report.paid_tier_requests, 0)
    assert.equal(report.paid_tier_refused, 0)
    assert.equal(report.estimated_savings_usd, 0)
    assert.equal(report.per_provider.length, 2)
    assert.equal(report.per_provider[0].requests, 0)
    assert.equal(report.per_provider[1].requests, 0)
    assert.ok(report.generated_at > 0)
  })

  // ── 2. Single provider ────────────────────────────────────────────

  it('single provider: 1000 free-tier requests at $0.01 = $10.00 savings', async () => {
    const tracker = new MockUsageTracker()
    tracker.setProviderUtilization('groq', util(1000, 1000, dateMs('2026-06-25')))

    const costRates = new Map([['groq', 0.01]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport()

    assert.equal(report.total_requests, 1000)
    assert.equal(report.free_tier_requests, 1000)
    assert.equal(report.paid_tier_requests, 0)
    assert.equal(report.estimated_savings_usd, 10.0)
    assert.equal(report.per_provider.length, 1)
    assert.equal(report.per_provider[0].free_tier_requests, 1000)
    assert.equal(report.per_provider[0].estimated_savings_usd, 10.0)
  })

  // ── 3. Multi-provider ─────────────────────────────────────────────

  it('multi-provider: 1000 groq + 500 cerebras + 5 refusals', async () => {
    const tracker = new MockUsageTracker()
    tracker.setProviderUtilization('groq', util(1000, 1000, dateMs('2026-06-25')))
    tracker.setProviderUtilization('cerebras', util(500, 500, dateMs('2026-06-25')))
    tracker.setRefusedCount('groq', 3)
    tracker.setRefusedCount('cerebras', 2)

    const costRates = new Map([['groq', 0.01], ['cerebras', 0.005]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport()

    assert.equal(report.total_requests, 1500)
    assert.equal(report.free_tier_requests, 1500) // both within free tier
    assert.equal(report.paid_tier_refused, 5)
    // Savings: 1000*$0.01 + 500*$0.005 = $10 + $2.50 = $12.50
    assert.equal(report.estimated_savings_usd, 12.5)

    // Per-provider
    assert.equal(report.per_provider.length, 2)

    const groq = report.per_provider.find(p => p.name === 'groq')
    assert.ok(groq)
    assert.equal(groq.requests, 1000)
    assert.equal(groq.paid_tier_refused, 3)
    assert.equal(groq.estimated_savings_usd, 10.0)

    const cerebras = report.per_provider.find(p => p.name === 'cerebras')
    assert.ok(cerebras)
    assert.equal(cerebras.requests, 500)
    assert.equal(cerebras.paid_tier_refused, 2)
    assert.equal(cerebras.estimated_savings_usd, 2.5)
  })

  // ── 4. Daily aggregation ──────────────────────────────────────────

  it('daily aggregation: requests across 3 days produce 3 buckets', async () => {
    const tracker = new MockUsageTracker()
    tracker.setProviderUtilization('groq', util(1000, 1000, dateMs('2026-06-20')))
    tracker.setProviderUtilization('cerebras', util(500, 500, dateMs('2026-06-21')))
    tracker.setProviderUtilization('together', util(200, 800, dateMs('2026-06-22')))

    const costRates = new Map([
      ['groq', 0.01],
      ['cerebras', 0.005],
      ['together', 0.005],
    ])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport({ dailyBuckets: true })

    assert.ok(report.daily, 'daily array should be present')
    assert.equal(report.daily.length, 3, 'should have 3 daily buckets')

    // Check dates are sorted
    assert.equal(report.daily[0].date, '2026-06-20')
    assert.equal(report.daily[1].date, '2026-06-21')
    assert.equal(report.daily[2].date, '2026-06-22')

    // Each bucket should have positive values
    for (const bucket of report.daily) {
      assert.ok(bucket.total_requests > 0, `bucket ${bucket.date} should have requests`)
    }
  })

  // ── 5. Paid-tier refusal count ────────────────────────────────────

  it('paid-tier refusal count: 5 refusals recorded', async () => {
    const tracker = new MockUsageTracker()
    tracker.setProviderUtilization('groq', util(1000, 1000, dateMs('2026-06-25')))
    tracker.setRefusedCount('groq', 5)

    const costRates = new Map([['groq', 0.01]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport()

    assert.equal(report.paid_tier_refused, 5)
    assert.equal(report.per_provider[0].paid_tier_refused, 5)
  })

  // ── 6. Savings calculation ────────────────────────────────────────

  it('savings calculation: $0.01 * 1000 = $10.00', async () => {
    const tracker = new MockUsageTracker()
    tracker.setProviderUtilization('groq', util(1000, 1000, dateMs('2026-06-25')))

    const costRates = new Map([['groq', 0.01]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport()

    assert.equal(report.estimated_savings_usd, 10.0)
    assert.equal(report.per_provider[0].estimated_savings_usd, 10.0)
  })

  // ── 7. Configurable cost rates ────────────────────────────────────

  it('configurable cost rates: $0.005 rate gives $5.00 savings', async () => {
    const tracker = new MockUsageTracker()
    tracker.setProviderUtilization('groq', util(1000, 1000, dateMs('2026-06-25')))

    // Different rate than test 2 — same usage, different savings
    const costRates = new Map([['groq', 0.005]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport()

    assert.equal(report.estimated_savings_usd, 5.0)
    assert.equal(report.per_provider[0].estimated_savings_usd, 5.0)
  })

  // ── 8. Time-window filtering ──────────────────────────────────────

  it('time-window filtering: sinceMs excludes old data', async () => {
    const tracker = new MockUsageTracker()
    // Provider with old data
    tracker.setProviderUtilization('groq', util(500, 1000, dateMs('2026-06-01')))
    // Provider with recent data
    tracker.setProviderUtilization('cerebras', util(300, 500, dateMs('2026-06-25')))

    const costRates = new Map([['groq', 0.01], ['cerebras', 0.005]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    // sinceMs = June 15 -> groq (June 1) is excluded, cerebras (June 25) included
    const sinceMs = dateMs('2026-06-15')
    const report = await reporter.getCostReport({ sinceMs })

    assert.equal(report.total_requests, 300, 'only cerebras should be counted')
    assert.equal(report.per_provider.length, 1, 'groq should be filtered out')
    assert.equal(report.per_provider[0].name, 'cerebras')
  })

  it('time-window filtering: untilMs excludes future data', async () => {
    const tracker = new MockUsageTracker()
    tracker.setProviderUtilization('groq', util(500, 1000, dateMs('2026-06-01')))
    tracker.setProviderUtilization('cerebras', util(300, 500, dateMs('2026-06-25')))

    const costRates = new Map([['groq', 0.01], ['cerebras', 0.005]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    // untilMs = June 10 -> cerebras (June 25) is excluded, groq (June 1) included
    const untilMs = dateMs('2026-06-10')
    const report = await reporter.getCostReport({ untilMs })

    assert.equal(report.total_requests, 500, 'only groq should be counted')
    assert.equal(report.per_provider.length, 1, 'cerebras should be filtered out')
    assert.equal(report.per_provider[0].name, 'groq')
  })

  // ── 9. Missing tracker source (throws) ────────────────────────────

  it('graceful skip when getAggregateProviderUtilization throws', async () => {
    const tracker = new MockUsageTracker()
    // groq is failing
    tracker.markFailing('groq')
    tracker.setProviderUtilization('cerebras', util(500, 500, dateMs('2026-06-25')))

    const costRates = new Map([['groq', 0.01], ['cerebras', 0.005]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const cap = captureConsole()
    try {
      const report = await reporter.getCostReport()

      // groq should be skipped, cerebras should still be counted
      assert.equal(report.total_requests, 500)
      assert.equal(report.per_provider.length, 1)
      assert.equal(report.per_provider[0].name, 'cerebras')

      // Warning should have been logged
      const warnings = cap.lines.filter(l => l.includes('[cost-reporter]'))
      assert.ok(warnings.length > 0, 'warning should be logged for failing provider')
      assert.ok(warnings[0].includes('groq'), 'warning should mention failing provider')
    } finally {
      cap.restore()
    }
  })

  // ── 10. Zero providers ────────────────────────────────────────────

  it('zero providers: empty costRates returns empty report', async () => {
    const tracker = new MockUsageTracker()
    const costRates = new Map<string, number>()
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport()

    assert.equal(report.total_requests, 0)
    assert.equal(report.free_tier_requests, 0)
    assert.equal(report.paid_tier_requests, 0)
    assert.equal(report.paid_tier_refused, 0)
    assert.equal(report.estimated_savings_usd, 0)
    assert.deepEqual(report.per_provider, [])
  })

  // ── 11. Paid-tier requests above limit ────────────────────────────

  it('paid-tier requests counted when current exceeds limit', async () => {
    const tracker = new MockUsageTracker()
    // 1200 requests but only 1000 free tier limit -> 200 paid-tier
    tracker.setProviderUtilization('groq', util(1200, 1000, dateMs('2026-06-25')))

    const costRates = new Map([['groq', 0.01]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport()

    assert.equal(report.total_requests, 1200)
    assert.equal(report.free_tier_requests, 1000)
    assert.equal(report.paid_tier_requests, 200)
    // Savings = free_tier_requests * rate = 1000 * $0.01 = $10.00
    assert.equal(report.estimated_savings_usd, 10.0)
  })

  // ── 12. Daily buckets not included when flag is false ─────────────

  it('daily buckets omitted when dailyBuckets is not set', async () => {
    const tracker = new MockUsageTracker()
    tracker.setProviderUtilization('groq', util(100, 1000, dateMs('2026-06-25')))

    const costRates = new Map([['groq', 0.01]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport()

    assert.equal(report.daily, undefined, 'daily should not be present')
  })

  // ── 13. Providers with null lastUsedAt are excluded from daily ────

  it('providers with null lastUsedAt do not appear in daily buckets', async () => {
    const tracker = new MockUsageTracker()
    // Provider has data but no lastUsedAt
    tracker.setProviderUtilization('groq', util(100, 1000, null))

    const costRates = new Map([['groq', 0.01]])
    const reporter = new CostReporter({ usageTracker: tracker, costRates })

    const report = await reporter.getCostReport({ dailyBuckets: true })

    assert.ok(report.daily, 'daily array should be present')
    assert.equal(report.daily.length, 0, 'no daily buckets for null lastUsedAt')
    // Report totals should still work
    assert.equal(report.total_requests, 100)
  })
})
