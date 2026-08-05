/**
 * UsageTracker — per-key usage tracking with SQLite persistence.
 *
 * Tracks request count, token count, and last_used_at per (key_id, provider).
 * Also maintains per-provider free-tier limits for quota enforcement.
 */

import Database from 'better-sqlite3'

// ── Types ──────────────────────────────────────────────────────────────

export interface UsageRecord {
  key_id: string
  provider: string
  request_count: number
  token_count: number
  last_used_at: number
  free_tier_limit: number
}

export interface ProviderUtilization {
  current: number
  limit: number
  utilization_pct: number
  /** Requests per minute in the tracked window. */
  ratePerMinute: number
  /** Timestamp of the most recent request, or null if none. */
  lastUsedAt: number | null
}

// ── UsageTracker ───────────────────────────────────────────────────────

export class UsageTracker {
  private db: Database.Database

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        key_id TEXT,
        provider TEXT,
        request_count INT DEFAULT 0,
        token_count INT DEFAULT 0,
        last_used_at INT,
        free_tier_limit INT NOT NULL DEFAULT 1000,
        PRIMARY KEY (key_id)
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tier_config (
        provider TEXT PRIMARY KEY,
        free_tier_limit INT NOT NULL DEFAULT 1000
      )
    `)
  }

  /**
   * Record a usage event for the given key and provider.
   * Increments request_count, adds tokens_used, updates last_used_at.
   */
  record(key_id: string, provider: string, tokens_used: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO usage (key_id, provider, request_count, token_count, last_used_at, free_tier_limit)
      VALUES (?, ?, 1, ?, ?, COALESCE((SELECT free_tier_limit FROM tier_config WHERE provider = ?), 1000))
      ON CONFLICT(key_id) DO UPDATE SET
        request_count = request_count + 1,
        token_count = token_count + ?,
        last_used_at = ?
    `)
    const now = Date.now()
    stmt.run(key_id, provider, tokens_used, now, provider, tokens_used, now)
  }

  /**
   * Get usage record for a specific key_id.
   */
  getUsage(key_id: string): UsageRecord | null {
    const row = this.db.prepare('SELECT * FROM usage WHERE key_id = ?').get(key_id) as UsageRecord | undefined
    return row ?? null
  }

  /**
   * Get aggregate utilization across all keys for a provider.
   * Sums request_count and uses the tier_config limit for that provider.
   * Returns 0 limit when provider is not configured.
   */
  getAggregateProviderUtilization(provider: string): ProviderUtilization {
    const usageRow = this.db.prepare(
      'SELECT COALESCE(SUM(request_count), 0) as total, COALESCE(MAX(last_used_at), 0) as last_used FROM usage WHERE provider = ?',
    ).get(provider) as { total: number; last_used: number } | undefined

    const configRow = this.db.prepare(
      'SELECT free_tier_limit FROM tier_config WHERE provider = ?',
    ).get(provider) as { free_tier_limit: number } | undefined

    const current = usageRow?.total ?? 0
    const limit = configRow?.free_tier_limit ?? 1000
    const utilization_pct = limit > 0 ? current / limit : 0
    // Rate estimation: use data from the last 5 minutes
    const windowMs = 5 * 60 * 1000
    const cutoff = Date.now() - windowMs
    const recentRow = this.db.prepare(
      "SELECT COUNT(*) as recent FROM usage WHERE provider = ? AND last_used_at >= ?",
    ).get(provider, cutoff) as { recent: number } | undefined
    const ratePerMinute = (recentRow?.recent ?? current) / 5
    const lastUsedAt = usageRow?.last_used ?? null

    return { current, limit, utilization_pct, ratePerMinute, lastUsedAt }
  }

  /**
   * Get utilization as a percentage of the free-tier limit.
   * If the key has no usage yet, returns 0%.
   */
  getProviderUtilization(key_id: string, provider: string): ProviderUtilization {
    const row = this.db.prepare(
      'SELECT request_count, free_tier_limit, last_used_at FROM usage WHERE key_id = ?',
    ).get(key_id) as { request_count: number; free_tier_limit: number; last_used_at: number } | undefined

    if (!row) {
      return { current: 0, limit: 1000, utilization_pct: 0, ratePerMinute: 0, lastUsedAt: null }
    }

    return {
      current: row.request_count,
      limit: row.free_tier_limit,
      utilization_pct: row.free_tier_limit > 0 ? row.request_count / row.free_tier_limit : 0,
      ratePerMinute: 0,
      lastUsedAt: row.last_used_at,
    }
  }

  /**
   * Configure per-provider free-tier request limit.
   * When a new key is first recorded for this provider, the configured limit is used.
   */
  setFreeTierLimit(provider: string, limit: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tier_config (provider, free_tier_limit)
      VALUES (?, ?)
    `).run(provider, limit)
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close()
  }
}

// ── UsageTracker Interface (for QuotaMonitor) ──────────────────────────

/**
 * Abstract interface for usage tracking — allows QuotaMonitor to work
 * with either the SQLite-backed UsageTracker (S01) or InMemoryUsageTracker.
 */
export interface IUsageTracker {
  record(keyId: string, provider: string, tokens: number): void
  getUsage(keyId: string): UsageRecord | null
  getProviderUtilization(keyId: string, provider: string): ProviderUtilization
  getAggregateProviderUtilization(provider: string): ProviderUtilization
}

/**
 * In-memory UsageTracker — used for testing QuotaMonitor and bootstrapping.
 * Stores usage entries in memory and computes per-provider utilization
 * via aggregation across keys.
 */
export class InMemoryUsageTracker implements IUsageTracker {
  private entries: Array<{ keyId: string; provider: string; tokens: number; timestamp: number }> = []
  private readonly windowMinutes: number
  private readonly providerLimits: Record<string, number> = {
    groq: 1000,
    cerebras: 500,
    together: 800,
  }

  constructor(windowMinutes: number = 5) {
    this.windowMinutes = windowMinutes
  }

  setProviderLimit(provider: string, limit: number): void {
    this.providerLimits[provider] = limit
  }

  record(keyId: string, provider: string, tokens: number): void {
    this.entries.push({ keyId, provider, tokens, timestamp: Date.now() })
  }

  getUsage(keyId: string): UsageRecord | null {
    const matching = this.entries.filter(e => e.keyId === keyId)
    if (matching.length === 0) return null
    return {
      key_id: keyId,
      provider: matching[0].provider,
      request_count: matching.length,
      token_count: matching.reduce((s, e) => s + e.tokens, 0),
      last_used_at: Math.max(...matching.map(e => e.timestamp)),
      free_tier_limit: this.providerLimits[matching[0].provider] ?? 1000,
    }
  }

  getAggregateProviderUtilization(provider: string): ProviderUtilization {
    const providerEntries = this.entries.filter(e => e.provider === provider)
    const now = Date.now()
    const windowStart = now - this.windowMinutes * 60 * 1000
    const recentEntries = providerEntries.filter(e => e.timestamp >= windowStart)
    const current = providerEntries.length
    const limit = this.providerLimits[provider] ?? 1000
    const lastUsedAt = providerEntries.length > 0
      ? Math.max(...providerEntries.map(e => e.timestamp))
      : null
    const ratePerMinute = this.windowMinutes > 0 ? recentEntries.length / this.windowMinutes : 0
    return {
      current,
      limit,
      utilization_pct: limit > 0 ? current / limit : 0,
      ratePerMinute,
      lastUsedAt,
    }
  }

  getProviderUtilization(keyId: string, provider: string): ProviderUtilization {
    const keyEntries = this.entries.filter(e => e.keyId === keyId && e.provider === provider)
    const current = keyEntries.length
    const limit = this.providerLimits[provider] ?? 1000
    const lastUsedAt = keyEntries.length > 0
      ? Math.max(...keyEntries.map(e => e.timestamp))
      : null
    return {
      current,
      limit,
      utilization_pct: limit > 0 ? current / limit : 0,
      ratePerMinute: 0,
      lastUsedAt,
    }
  }
}
