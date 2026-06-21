/**
 * Heal integration — wraps engram::heal_json for gateway failover.
 *
 * When a provider returns malformed JSON, FailoverEngine calls
 * healMalformedJson(jsonString, deps) before falling through to the
 * next provider. The wrapper:
 * - Has a 2s timeout
 * - Returns a parsed object on success
 * - Returns null on heal failure (timeout, unreachable, invalid result)
 * - Never throws
 *
 * Pure function with injected deps for testability.
 */

export interface HealIntegrationDeps {
  /** Call engram::heal_json via iii-sdk. Returns the heal response. */
  callHeal: (jsonString: string, timeoutMs: number) => Promise<unknown>
  /** Optional logger for structured events. */
  log?: (event: Record<string, unknown>) => void
}

export const HEAL_TIMEOUT_MS = 2000

export async function healMalformedJson(
  jsonString: string,
  deps: HealIntegrationDeps,
  timeoutMs: number = HEAL_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    const result = await Promise.race([deps.callHeal(jsonString, timeoutMs), timeoutPromise])
    if (timer) clearTimeout(timer)
    if (!result || typeof result !== 'object') return null
    const obj = result as Record<string, unknown>
    // engram::heal_json returns { repaired: string } on success
    if (typeof obj.repaired !== 'string') return null
    try {
      const reparsed = JSON.parse(obj.repaired)
      if (reparsed && typeof reparsed === 'object') {
        deps.log?.({ event: 'heal_invoked', success: true })
        return reparsed as Record<string, unknown>
      }
    } catch {
      // healed output not valid JSON
    }
    deps.log?.({ event: 'heal_invoked', success: false, reason: 'parse_error' })
    return null
  } catch (err) {
    if (timer) clearTimeout(timer)
    deps.log?.({ event: 'heal_failed', error: String(err) })
    return null
  }
}
