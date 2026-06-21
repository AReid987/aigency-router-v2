/**
 * Failover Engine — iterates through provider arrays with cooldown tracking.
 *
 * Handles rate limits (429), forbidden keys (403), server errors (500/503),
 * and invalid keys (401) by cooling down failing providers and trying the next.
 */

import { ProviderError, type Message, type ProviderConfig, type ProviderResponse, type StreamChunk } from './provider-client.ts'

// ── Types ──────────────────────────────────────────────────────────────

export interface RouteOptions {
  stream?: boolean
  maxTokens?: number
  temperature?: number
}

export interface RouteSuccess {
  success: true
  provider: string
  response: ProviderResponse
}

export interface RouteFailure {
  success: false
  message: string
  failures: { provider: string; status: number | null; reason: string }[]
}

export type RouteResult = RouteSuccess | RouteFailure

export interface CallProviderFn {
  (
    config: ProviderConfig,
    apiKey: string,
    model: string,
    messages: Message[],
    options?: { stream?: boolean; maxTokens?: number; temperature?: number },
  ): Promise<ProviderResponse | AsyncGenerator<StreamChunk>>
}

export interface GetKeyFn {
  (providerId: string): Promise<string | null>
}

// ── Cooldown durations (ms) ────────────────────────────────────────────

const COOLDOWN_429 = 60_000       // rate limit: 60s
const COOLDOWN_403 = 300_000      // forbidden/revoked: 5min
const COOLDOWN_SERVER = 30_000    // 500/503: 30s

// ── Failover Engine ────────────────────────────────────────────────────

export class FailoverEngine {
  private cooldowns = new Map<string, number>()
  private getKey: GetKeyFn
  private callProvider: CallProviderFn
  /**
   * Optional: try to heal a malformed provider response before falling through
   * to the next provider. Returns a replacement ProviderResponse on success,
   * null to fall through. Default: noop (heal disabled).
   */
  tryHeal: (rawBody: string) => Promise<ProviderResponse | null> = async () => null

  constructor(getKey: GetKeyFn, callProvider: CallProviderFn) {
    this.getKey = getKey
    this.callProvider = callProvider
  }

  /**
   * Detect a malformed non-streaming response. Currently: empty content.
   * Extend this as we learn more failure shapes (truncated JSON, etc.).
   */
  private isMalformedResponse(response: ProviderResponse | AsyncGenerator<StreamChunk, any, any>): boolean {
    if (!response || typeof response !== 'object' || Symbol.asyncIterator in response) {
      return false
    }
    const r = response as ProviderResponse
    return !r.content || r.content.length === 0
  }

  isInCooldown(provider: string): boolean {
    const until = this.cooldowns.get(provider)
    if (until == null) return false
    if (Date.now() >= until) {
      this.cooldowns.delete(provider)
      return false
    }
    return true
  }

  setCooldown(provider: string, durationMs: number): void {
    this.cooldowns.set(provider, Date.now() + durationMs)
  }

  getCooldowns(): Map<string, number> {
    // Clean up expired entries
    const now = Date.now()
    for (const [k, v] of this.cooldowns) {
      if (now >= v) this.cooldowns.delete(k)
    }
    return new Map(this.cooldowns)
  }

  async routeWithFailover(
    providerArray: string[],
    model: string,
    messages: Message[],
    options: RouteOptions = {},
  ): Promise<RouteResult> {
    const failures: RouteFailure['failures'] = []

    for (const providerModel of providerArray) {
      // Parse "provider/model" format
      const slashIdx = providerModel.indexOf('/')
      const providerId = slashIdx === -1 ? providerModel : providerModel.slice(0, slashIdx)
      const providerModelName = slashIdx === -1 ? model : providerModel.slice(slashIdx + 1)

      // Skip providers in cooldown
      if (this.isInCooldown(providerId)) {
        failures.push({ provider: providerId, status: null, reason: 'in cooldown' })
        continue
      }

      // Fetch API key from vault
      const apiKey = await this.getKey(providerId)
      if (apiKey == null) {
        failures.push({ provider: providerId, status: null, reason: 'no API key available' })
        continue
      }

      // Look up provider config
      const { getProviderConfig } = await import('./provider-client.ts')
      const config = getProviderConfig(providerId)
      if (config == null) {
        failures.push({ provider: providerId, status: null, reason: 'unknown provider' })
        continue
      }

      try {
        const response = await this.callProvider(config, apiKey, providerModelName, messages, {
          stream: options.stream,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
        })
        // Heuristic: for non-streaming responses, if the content looks malformed (empty),
        // try to heal before declaring success. Streaming responses are passed through.
        if (!options.stream && this.isMalformedResponse(response)) {
          const rawBody = (response as ProviderResponse).content
          const healed = await this.tryHeal(rawBody)
          if (healed != null) {
            return { success: true, provider: providerId, response: healed as ProviderResponse }
          }
        }
        return { success: true, provider: providerId, response: response as ProviderResponse }
      } catch (err: unknown) {
        if (err instanceof ProviderError) {
          const status = err.status
          if (status === 429) {
            this.setCooldown(providerId, COOLDOWN_429)
            failures.push({ provider: providerId, status, reason: 'rate limited' })
          } else if (status === 403) {
            this.setCooldown(providerId, COOLDOWN_403)
            failures.push({ provider: providerId, status, reason: 'forbidden/revoked' })
          } else if (status === 500 || status === 503) {
            this.setCooldown(providerId, COOLDOWN_SERVER)
            failures.push({ provider: providerId, status, reason: 'server error' })
          } else if (status === 401) {
            // Don't cooldown — key might be wrong, not provider down
            failures.push({ provider: providerId, status, reason: 'invalid API key' })
          } else {
            failures.push({ provider: providerId, status, reason: `HTTP ${status}` })
          }
        } else {
          failures.push({ provider: providerId, status: null, reason: String(err) })
        }
      }
    }

    return {
      success: false,
      message: `All ${failures.length} provider(s) failed`,
      failures,
    }
  }
}
