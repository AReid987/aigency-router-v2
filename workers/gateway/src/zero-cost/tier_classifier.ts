/**
 * TierClassifier — classifies providers as 'free' or 'paid' based on config.
 *
 * Default config marks Groq, Cerebras, Together as free;
 * OpenAI and Anthropic as paid.
 *
 * Can be overridden via the PROVIDER_TIER_OVERRIDE env var.
 * Format: `PROVIDER_TIER_OVERRIDE=groq:paid,cerebras:free`
 */

// ── Default config ─────────────────────────────────────────────────────

export const DEFAULT_TIER_CONFIG: Readonly<Record<string, 'free' | 'paid'>> = Object.freeze({
  groq: 'free',
  cerebras: 'free',
  together: 'free',
  openai: 'paid',
  anthropic: 'paid',
})

// ── Parse env overrides ────────────────────────────────────────────────

/**
 * Parse a PROVIDER_TIER_OVERRIDE string into a provider→tier map.
 * Exported for testing.
 */
export function parseTierOverrides(raw: string | undefined): Record<string, 'free' | 'paid'> {
  const overrides: Record<string, 'free' | 'paid'> = {}
  if (!raw) return overrides

  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const [providerRaw, tierRaw] = trimmed.split(':').map(s => s.trim().toLowerCase())
    if (!providerRaw || !tierRaw) continue
    if (tierRaw === 'free' || tierRaw === 'paid') {
      overrides[providerRaw] = tierRaw
    }
  }

  return overrides
}

// ── Compute final config ───────────────────────────────────────────────

function buildConfig(): Readonly<Record<string, 'free' | 'paid'>> {
  const config: Record<string, 'free' | 'paid'> = { ...DEFAULT_TIER_CONFIG }
  const overrides = parseTierOverrides(process.env.PROVIDER_TIER_OVERRIDE)
  for (const [provider, tier] of Object.entries(overrides)) {
    config[provider] = tier
  }
  return Object.freeze(config)
}

export const PROVIDER_TIER_CONFIG = buildConfig()

// ── TierClassifier ─────────────────────────────────────────────────────

export class TierClassifier {
  /**
   * Classify a provider as 'free' or 'paid'.
   * Unknown providers default to 'paid' (conservative).
   */
  static classify(provider: string): 'free' | 'paid' {
    return PROVIDER_TIER_CONFIG[provider.toLowerCase()] ?? 'paid'
  }

  /**
   * Reset and return the current config (useful for testing).
   */
  static getConfig(): Readonly<Record<string, 'free' | 'paid'>> {
    return PROVIDER_TIER_CONFIG
  }
}
