/**
 * ZeroCostCircuitBreaker — refuses paid-tier providers and exhausted free-tier keys.
 *
 * Integrates with UsageTracker for quota data and TierClassifier for tier
 * classification. Emits telemetry events for auditing and observability.
 */

import type { UsageTracker } from './usage_tracker.ts'
import { TierClassifier } from './tier_classifier.ts'
import type { TelemetryDeps } from '../../../shared/telemetry.ts'

// ── Types ──────────────────────────────────────────────────────────────

export interface CircuitBreakerResult {
  allowed: boolean
  reason?: 'paid_tier' | 'exhausted'
}

// ── ZeroCostCircuitBreaker ─────────────────────────────────────────────

export class ZeroCostCircuitBreaker {
  private usageTracker: UsageTracker
  private telemetryDeps?: TelemetryDeps

  constructor(
    usageTracker: UsageTracker,
    telemetryDeps?: TelemetryDeps,
  ) {
    this.usageTracker = usageTracker
    this.telemetryDeps = telemetryDeps
  }

  /**
   * Check whether a request for the given key and provider is allowed.
   *
   * - Paid-tier providers → refused with reason 'paid_tier', emits TIER_REFUSED
   * - Free-tier at 100% utilization → refused with reason 'exhausted', emits QUOTA_EXHAUSTED
   * - Free-tier under quota → allowed, emits COST_ENFORCED
   * - Always emits QUOTA_CHECK for observability
   */
  async check(key_id: string, provider: string): Promise<CircuitBreakerResult> {
    const tier = TierClassifier.classify(provider)

    if (tier === 'paid') {
      await this.emit('TIER_REFUSED', { key_id, provider, tier })
      await this.emit('QUOTA_CHECK', { key_id, provider, tier, allowed: false })
      return { allowed: false, reason: 'paid_tier' }
    }

    const utilization = this.usageTracker.getProviderUtilization(key_id, provider)

    if (utilization.utilization_pct >= 1.0) {
      await this.emit('QUOTA_EXHAUSTED', { key_id, provider, tier, current: utilization.current, limit: utilization.limit })
      await this.emit('QUOTA_CHECK', { key_id, provider, tier, allowed: false })
      return { allowed: false, reason: 'exhausted' }
    }

    await this.emit('COST_ENFORCED', { key_id, provider, tier, utilization_pct: utilization.utilization_pct })
    await this.emit('QUOTA_CHECK', { key_id, provider, tier, allowed: true })
    return { allowed: true }
  }

  /**
   * Fire-and-forget telemetry emission.
   */
  private async emit(eventClass: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.telemetryDeps) return
    const { logTelemetry } = await import('../../../shared/telemetry.ts')
    await logTelemetry(this.telemetryDeps!, {
      eventClass: eventClass as any,
      sourceWorker: 'gateway',
      payload,
    })
  }
}
