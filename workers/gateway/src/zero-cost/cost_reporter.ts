/**
 * CostReporter — aggregates UsageTracker data into cost reports.
 *
 * For each known provider (derived from costRates keys), reads aggregate
 * utilization, computes free-tier vs paid-tier breakdown, estimates
 * savings based on cost rates, and optionally produces daily bucketed
 * views.
 *
 * Satisfies the structural CostReporter interface expected by
 * cost_endpoint.ts (S03).
 */

import type { IUsageTracker } from './usage_tracker.ts'

// ── Types ──────────────────────────────────────────────────────────────

export interface CostReportProvider {
  name: string
  requests: number
  free_tier_requests: number
  paid_tier_refused: number
  estimated_savings_usd: number
}

export interface CostReportDaily {
  date: string
  total_requests: number
  savings_usd: number
}

export interface CostReport {
  total_requests: number
  free_tier_requests: number
  paid_tier_requests: number
  paid_tier_refused: number
  estimated_savings_usd: number
  per_provider: CostReportProvider[]
  daily?: CostReportDaily[]
  generated_at: number
}

// ── CostReporter ───────────────────────────────────────────────────────

export class CostReporter {
  private readonly usageTracker: IUsageTracker
  private readonly costRates: ReadonlyMap<string, number>

  constructor(options: {
    usageTracker: IUsageTracker
    costRates: Map<string, number>
    /** Rate used as free-tier alternative cost baseline (optional). */
    freeProviderCosts?: Map<string, number>
  }) {
    this.usageTracker = options.usageTracker
    this.costRates = options.costRates
  }

  /**
   * Produce a cost report from the usage tracker data.
   *
   * @param opts.sinceMs - Optional lower bound (ms epoch). Providers whose
   *   last_used_at is null or earlier than this are excluded.
   * @param opts.untilMs - Optional upper bound (ms epoch). Providers whose
   *   last_used_at is later than this are excluded.
   * @param opts.dailyBuckets - When true, adds a `daily` array grouping
   *   per-provider last_used_at timestamps by calendar date.
   */
  async getCostReport(opts?: {
    sinceMs?: number
    untilMs?: number
    dailyBuckets?: boolean
  }): Promise<CostReport> {
    const providers = Array.from(this.costRates.keys())

    // Internal carrier — collects data during the provider iteration so we
    // have consistent values for both the per_provider array and daily buckets.
    const collected: Array<{
      name: string
      current: number
      freeTierRequests: number
      refused: number
      savings: number
      lastUsedAt: number | null
    }> = []

    for (const provider of providers) {
      // 1. Read aggregate utilization
      let current: number
      let limit: number
      let lastUsedAt: number | null

      try {
        const util = this.usageTracker.getAggregateProviderUtilization(provider)
        current = util.current
        limit = util.limit
        lastUsedAt = util.lastUsedAt
      } catch {
        console.warn(`[cost-reporter] Failed to get utilization for provider: ${provider}`)
        continue
      }

      // 2. Time-window filtering
      if (opts?.sinceMs !== undefined) {
        if (lastUsedAt === null || lastUsedAt < opts.sinceMs) {
          continue
        }
      }
      if (opts?.untilMs !== undefined) {
        if (lastUsedAt !== null && lastUsedAt > opts.untilMs) {
          continue
        }
      }

      // 3. Compute free-tier / paid-tier breakdown
      const freeTierRequests = Math.min(current, limit)
      const rate = this.costRates.get(provider) ?? 0
      const savings = freeTierRequests * rate

      // 4. Optional: paid-tier refusal count
      let refused = 0
      if (typeof (this.usageTracker as Record<string, unknown>).getRefusedCount === 'function') {
        try {
          refused = (this.usageTracker as (arg0: string) => number & {
            getRefusedCount: (p: string) => number
          }).getRefusedCount(provider)
        } catch {
          // Optional method — ignore errors
        }
      }

      collected.push({
        name: provider,
        current,
        freeTierRequests,
        refused,
        savings,
        lastUsedAt,
      })
    }

    // 5. Build per_provider array
    const perProvider: CostReportProvider[] = collected.map(c => ({
      name: c.name,
      requests: c.current,
      free_tier_requests: c.freeTierRequests,
      paid_tier_refused: c.refused,
      estimated_savings_usd: c.savings,
    }))

    // 6. Compute totals
    const totalRequests = collected.reduce((s, c) => s + c.current, 0)
    const totalFreeTier = collected.reduce((s, c) => s + c.freeTierRequests, 0)
    const totalRefused = collected.reduce((s, c) => s + c.refused, 0)
    const totalSavings = collected.reduce((s, c) => s + c.savings, 0)

    const report: CostReport = {
      total_requests: totalRequests,
      free_tier_requests: totalFreeTier,
      paid_tier_requests: totalRequests - totalFreeTier,
      paid_tier_refused: totalRefused,
      estimated_savings_usd: totalSavings,
      per_provider: perProvider,
      generated_at: Date.now(),
    }

    // 7. Optional daily buckets
    if (opts?.dailyBuckets) {
      report.daily = this.buildDailyBuckets(collected)
    }

    return report
  }

  /**
   * Group per-provider data by calendar date using each provider's
   * last_used_at timestamp. Multiple providers sharing the same date
   * are merged into a single bucket.
   */
  private buildDailyBuckets(
    collected: Array<{
      name: string
      current: number
      savings: number
      lastUsedAt: number | null
    }>,
  ): CostReportDaily[] {
    const dailyMap = new Map<string, { requests: number; savings: number }>()

    for (const c of collected) {
      if (c.lastUsedAt === null) continue

      const date = new Date(c.lastUsedAt).toISOString().split('T')[0]
      const existing = dailyMap.get(date)
      if (existing) {
        existing.requests += c.current
        existing.savings += c.savings
      } else {
        dailyMap.set(date, { requests: c.current, savings: c.savings })
      }
    }

    return Array.from(dailyMap.entries())
      .map(([date, data]) => ({
        date,
        total_requests: data.requests,
        savings_usd: data.savings,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }
}
