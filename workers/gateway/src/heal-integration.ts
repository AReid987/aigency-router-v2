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

import type { ISdk } from 'iii-sdk'

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

// ── engram::heal_json Wire ────────────────────────────────────────────

/**
 * Native engram::heal_json response shape (see workers/engram/src/heal-json.ts).
 * On success the parsed object is in `data`; on failure `error` describes why.
 */
interface EngramHealNativeResponse {
  success: boolean
  data?: unknown
  attempts?: number
  error?: string
  partial?: string
}

/**
 * Build a `callHeal`-compatible function that dispatches to engram::heal_json
 * over iii-sdk. Transforms engram's native `{ success, data, attempts }` shape
 * into the `{ repaired: string }` shape that healMalformedJson expects, by
 * re-stringifying the parsed `data` field.
 *
 * Never throws — returns null on:
 *   - iii.trigger error (engine unreachable, RPC failure)
 *   - non-object response
 *   - native heal unsuccessful (`success === false`)
 *   - circular / non-serializable `data` (stringify failure)
 *
 * Timeout enforcement is handled by healMalformedJson via Promise.race; the
 * `timeoutMs` value is passed through for logging and to the iii call config.
 */
export function callEngramHeal(
  iii: ISdk,
  timeoutMs: number = HEAL_TIMEOUT_MS,
  log?: (event: Record<string, unknown>) => void,
): (jsonString: string, timeoutMs: number) => Promise<unknown> {
  return async (jsonString: string, _callTimeoutMs: number) => {
    log?.({ event: 'engram_heal_invoked', timeoutMs })
    try {
      const result = await iii.trigger({
        function_id: 'engram::heal_json',
        payload: { jsonString },
      })
      if (!result || typeof result !== 'object') {
        log?.({ event: 'engram_heal_failed', error: 'non_object_response' })
        return null
      }
      const resp = result as EngramHealNativeResponse
      if (resp.success !== true) {
        log?.({
          event: 'engram_heal_failed',
          error: resp.error ?? 'native_heal_unsuccessful',
          attempts: resp.attempts ?? 0,
        })
        return null
      }
      try {
        return { repaired: JSON.stringify(resp.data) }
      } catch {
        log?.({ event: 'engram_heal_failed', error: 'stringify_error' })
        return null
      }
    } catch (err) {
      log?.({ event: 'engram_heal_failed', error: String(err) })
      return null
    }
  }
}
