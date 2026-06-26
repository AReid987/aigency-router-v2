/**
 * TierConfigCache — wraps a TierProbe with stale-while-revalidate caching.
 *
 * - First call for a provider: probes, caches, returns
 * - Subsequent calls within refresh_interval_ms: returns cached (no probe)
 * - Calls after refresh_interval_ms: re-probes (returns stale if probe fails)
 * - Concurrent calls: deduplicated (single in-flight probe per provider)
 * - Optional periodic background refresh re-probes all known providers
 *   and emits TIER_CONFIG_REFRESHED events.
 */

import type { TelemetryDeps } from '../../../shared/telemetry.ts'

// ── Types ──────────────────────────────────────────────────────────────

export interface TierProbeResult {
  /** Tier classification string, e.g. 'free' or 'paid'. */
  tier: string
  /** Rate-limit information from the probe. */
  rateLimits: Record<string, unknown>
  /** Latency of the probe in milliseconds. */
  latencyMs: number
}

export interface TierProbe {
  /** Probe a provider endpoint and return tier + rate-limit info. */
  probe(url: string, apiKey?: string): Promise<TierProbeResult>
}

export interface CachedTierResult {
  /** Tier classification string, e.g. 'free', 'paid', or 'unknown'. */
  tier: string
  /** Rate-limit information. */
  rateLimits: Record<string, unknown>
  /** Unix timestamp (ms) when this result was probed. */
  probedAt: number
  /** Probe latency in milliseconds. */
  latencyMs: number
  /** Error message if the probe failed (probe may still have a stale result). */
  error?: string
}

export interface KnownProvider {
  name: string
  url: string
  apiKey?: string
}

export interface TierConfigCacheOptions {
  /** Refresh interval in milliseconds (default: 600_000 = 10 min). */
  refresh_interval_ms?: number
  /** Providers to periodically re-probe in the background. */
  known_providers?: Array<KnownProvider>
  /** Telemetry dependencies for event emission. */
  telemetry_deps?: TelemetryDeps
}

// ── TierConfigCache ────────────────────────────────────────────────────

export class TierConfigCache {
  private probe: TierProbe
  private refreshIntervalMs: number
  private knownProviders: Array<KnownProvider>
  private telemetryDeps?: TelemetryDeps
  private cache: Map<string, CachedTierResult> = new Map()
  private inFlight: Map<string, Promise<CachedTierResult>> = new Map()
  private intervalId: ReturnType<typeof setInterval> | null = null

  constructor(probe: TierProbe, options?: TierConfigCacheOptions) {
    this.probe = probe
    this.refreshIntervalMs = options?.refresh_interval_ms ?? 600_000
    this.knownProviders = options?.known_providers ?? []
    this.telemetryDeps = options?.telemetry_deps
  }

  /**
   * Get the cached tier result for a provider.
   *
   * Stale-while-revalidate semantics:
   * - Fresh cache (probedAt within interval): returns cached immediately
   * - Stale cache (probedAt past interval): re-probes in background;
   *   returns new result on success, stale cached on failure
   * - No cache: probes and caches the result
   *
   * Concurrent calls for the same provider are deduplicated —
   * only one probe is in-flight at a time.
   */
  async getProviderTier(provider: string): Promise<CachedTierResult> {
    const cached = this.cache.get(provider)
    const now = Date.now()

    // Fresh cache — return immediately without probing
    if (cached && now - cached.probedAt < this.refreshIntervalMs) {
      return cached
    }

    // Stale or no cache — try to re-probe (deduplicated)
    return this.fetchOrWait(provider)
  }

  /**
   * Start periodic background refresh.
   * Re-probes all known_providers at the configured interval.
   * Idempotent — safe to call multiple times.
   */
  start(): void {
    if (this.intervalId !== null) return
    this.intervalId = setInterval(() => {
      void this.refreshAll()
    }, this.refreshIntervalMs)
  }

  /**
   * Stop periodic background refresh.
   * Safe to call if not started.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Fetch or wait for an in-flight probe for the given provider.
   * Deduplicates concurrent calls.
   */
  private async fetchOrWait(provider: string): Promise<CachedTierResult> {
    // If there is already an in-flight probe, join it
    const existing = this.inFlight.get(provider)
    if (existing) return existing

    // Start a new probe and track it
    const promise = this.doProbe(provider)
    this.inFlight.set(provider, promise)

    try {
      return await promise
    } finally {
      this.inFlight.delete(provider)
    }
  }

  /**
   * Perform a single probe for the given provider.
   * On success: caches and returns the result.
   * On failure: returns stale cached if available, otherwise error result.
   */
  private async doProbe(provider: string): Promise<CachedTierResult> {
    const knownProvider = this.knownProviders.find(p => p.name === provider)
    if (!knownProvider) {
      // No URL known — cannot probe. If stale exists, return it.
      const stale = this.cache.get(provider)
      if (stale) return stale
      return {
        tier: 'unknown',
        rateLimits: {},
        probedAt: Date.now(),
        latencyMs: 0,
        error: `No known provider URL for "${provider}"`,
      }
    }

    const start = Date.now()
    try {
      const result = await this.probe.probe(knownProvider.url, knownProvider.apiKey)
      const probedAt = Date.now()
      const latencyMs = probedAt - start

      // If probe returned unknown, this is a failure — return stale if available
      if (!result.tier || result.tier === 'unknown') {
        const stale = this.cache.get(provider)
        if (stale) return stale
        // No stale to fall back to — return the failed result
        return {
          tier: 'unknown',
          rateLimits: result.rateLimits,
          probedAt,
          latencyMs,
          error: 'Probe returned unknown tier',
        }
      }

      // Success — cache and return
      const fresh: CachedTierResult = {
        tier: result.tier,
        rateLimits: result.rateLimits,
        probedAt,
        latencyMs,
      }
      this.cache.set(provider, fresh)
      return fresh
    } catch (err) {
      const probedAt = Date.now()
      const latencyMs = probedAt - start
      const errorMsg = err instanceof Error ? err.message : String(err)

      // Stale-while-revalidate: return stale if available
      const stale = this.cache.get(provider)
      if (stale) return stale

      return {
        tier: 'unknown',
        rateLimits: {},
        probedAt,
        latencyMs,
        error: errorMsg,
      }
    }
  }

  /**
   * Re-probe all known providers in the background.
   * Emits TIER_CONFIG_REFRESHED events for each probe.
   */
  private async refreshAll(): Promise<void> {
    for (const provider of this.knownProviders) {
      const oldEntry = this.cache.get(provider.name)
      const oldTier = oldEntry?.tier

      try {
        const result = await this.doProbe(provider.name)
        this.cache.set(provider.name, result)
        const changed = result.tier !== oldTier

        void this.emitRefreshEvent(
          provider.name,
          result.tier,
          result.rateLimits,
          result.latencyMs,
          changed,
        )
      } catch (err) {
        console.warn(
          `[TierConfigCache] Background refresh failed for ${provider.name}:`,
          err,
        )
      }
    }
  }

  /**
   * Emit a TIER_CONFIG_REFRESHED telemetry event (fire-and-forget).
   */
  private async emitRefreshEvent(
    provider: string,
    tier: string,
    rateLimits: Record<string, unknown>,
    latencyMs: number,
    changed: boolean,
  ): Promise<void> {
    if (!this.telemetryDeps) return
    const { logTelemetry } = await import('../../../shared/telemetry.ts')
    await logTelemetry(this.telemetryDeps, {
      eventClass: 'TIER_CONFIG_REFRESHED' as any,
      sourceWorker: 'gateway',
      payload: { provider, tier, rateLimits, latencyMs, changed },
    })
  }
}
