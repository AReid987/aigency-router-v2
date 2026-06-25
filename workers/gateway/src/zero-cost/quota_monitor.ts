/**
 * Quota Monitor — reads from UsageTracker and exposes:
 *   (a) GET /v1/admin/quota endpoint data via getStatus()
 *   (b) threshold-based alerting (default 80%) via start()
 *
 * Opt-in via GATEWAY_QUOTA_MONITORING=true env var.
 */

import type { IUsageTracker, ProviderUtilization } from './usage_tracker.ts'
import type { TelemetryDeps } from '../../../shared/telemetry.ts'

// ── Types ──────────────────────────────────────────────────────────────

export interface QuotaProviderStatus {
  name: string
  current: number
  limit: number
  utilization_pct: number
  /** ISO-8601 string or null if exhaustion cannot be estimated. */
  projected_exhaustion_at: string | null
}

export interface QuotaStatus {
  providers: QuotaProviderStatus[]
}

export interface QuotaMonitorHandle {
  stop(): void
}

// ── Known Providers ────────────────────────────────────────────────────

const KNOWN_PROVIDERS = ['groq', 'cerebras', 'together'] as const

// ── QuotaMonitor ───────────────────────────────────────────────────────

export class QuotaMonitor {
  private readonly usageTracker: IUsageTracker
  private readonly threshold: number
  private readonly alertIntervalMs: number
  private readonly telemetryDeps?: TelemetryDeps
  private intervalId: ReturnType<typeof setInterval> | null = null
  private lastAlertedAt: Map<string, number> = new Map()
  private readonly alertCooldownMs: number = 60 * 60 * 1000 // 1 hour

  constructor(
    usageTracker: IUsageTracker,
    threshold: number = 0.8,
    alertIntervalMs: number = 60_000,
    telemetryDeps?: TelemetryDeps,
  ) {
    this.usageTracker = usageTracker
    this.threshold = threshold
    this.alertIntervalMs = alertIntervalMs
    this.telemetryDeps = telemetryDeps
  }

  // ── Status ──────────────────────────────────────────────────────────

  /**
   * Return per-provider quota utilization.
   * Iterates known providers, reads from UsageTracker, and computes
   * utilization percentage and projected exhaustion time.
   */
  getStatus(): QuotaStatus {
    const providers: QuotaProviderStatus[] = []

    for (const name of KNOWN_PROVIDERS) {
      let utilization: ProviderUtilization
      try {
        utilization = this.usageTracker.getAggregateProviderUtilization(name)
      } catch {
        // Provider not tracked — return empty stats
        providers.push({
          name,
          current: 0,
          limit: 0,
          utilization_pct: 0,
          projected_exhaustion_at: null,
        })
        continue
      }

      const { current, limit, ratePerMinute } = utilization
      const utilizationPct = limit > 0
        ? Math.round((current / limit) * 10000) / 100
        : 0

      // Estimate projected exhaustion time
      let projectedExhaustionAt: string | null = null
      if (limit > 0 && ratePerMinute > 0) {
        const remaining = limit - current
        if (remaining > 0) {
          const minutesRemaining = remaining / ratePerMinute
          const exhaustionMs = Date.now() + minutesRemaining * 60 * 1000
          projectedExhaustionAt = new Date(exhaustionMs).toISOString()
        } else {
          // Already at or past limit
          projectedExhaustionAt = new Date(Date.now()).toISOString()
        }
      }

      providers.push({
        name,
        current,
        limit,
        utilization_pct: utilizationPct,
        projected_exhaustion_at: projectedExhaustionAt,
      })
    }

    return { providers }
  }

  // ── Alerting ─────────────────────────────────────────────────────────

  /**
   * Start polling for threshold alerts.
   * Emits a structured QUOTA_ALERT event (via telemetry or console.log)
   * per provider when utilization crosses the threshold, idempotent per
   * provider per 1-hour cooldown window.
   */
  start(): QuotaMonitorHandle {
    if (this.intervalId !== null) {
      // Already started
      return { stop: () => this.stop() }
    }

    // Run immediately on start
    this.checkThresholds()

    this.intervalId = setInterval(() => {
      this.checkThresholds()
    }, this.alertIntervalMs)

    // Prevent the interval from keeping the process alive in tests
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      this.intervalId.unref()
    }

    return { stop: () => this.stop() }
  }

  /**
   * Stop the polling interval.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /**
   * Check all providers against the threshold and emit alerts.
   */
  private checkThresholds(): void {
    const status = this.getStatus()
    const now = Date.now()

    for (const provider of status.providers) {
      if (provider.utilization_pct >= this.threshold * 100) {
        // Check idempotency — have we alerted for this provider in the last hour?
        const lastAlerted = this.lastAlertedAt.get(provider.name) ?? 0
        if (now - lastAlerted < this.alertCooldownMs) {
          continue // Still within cooldown window
        }

        this.lastAlertedAt.set(provider.name, now)
        this.emitAlert(provider)
      }
    }
  }

  /**
   * Emit a QUOTA_ALERT event.
   * Uses telemetryDeps.trigger when available, falls back to console.log.
   */
  private emitAlert(provider: QuotaProviderStatus): void {
    const alertPayload = {
      eventClass: 'QUOTA_ALERT' as const,
      sourceWorker: 'gateway',
      payload: {
        provider: provider.name,
        currentUsage: provider.current,
        limit: provider.limit,
        utilizationPct: provider.utilization_pct,
        projectedExhaustionAt: provider.projected_exhaustion_at,
        threshold: this.threshold,
        timestamp: new Date().toISOString(),
      },
    }

    if (this.telemetryDeps) {
      // Fire-and-forget via telemetry system
      this.telemetryDeps.trigger('sugar-db', 'log_event', alertPayload)
        .catch(() => {
          console.warn(`[quota-monitor] Failed to emit QUOTA_ALERT for ${provider.name}`)
        })
    } else {
      // Fallback to console logging
      console.log(JSON.stringify({
        event: 'QUOTA_ALERT',
        ...alertPayload.payload,
        timestamp: new Date().toISOString(),
      }))
    }
  }

  /** Reset the alert cooldown map (for testing). */
  _resetAlertCooldowns(): void {
    this.lastAlertedAt.clear()
  }
}
