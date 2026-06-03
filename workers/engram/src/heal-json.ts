/**
 * healJson — Auto-repair malformed JSON from open-source LLMs.
 *
 * Strategy: JSON.parse → local jsonrepair → LLM repair loop (max 3).
 * Pure function with injected dependencies for testability.
 */

import { jsonrepair } from 'jsonrepair'

// ── Types ──────────────────────────────────────────────────────────────

export interface HealJsonInput {
  jsonString: string
  maxRetries?: number
  model?: string
}

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface HealJsonDeps {
  /** Call gateway to get LLM repair. Returns the model's response string. */
  callGateway?: (model: string, messages: Message[]) => Promise<string>
  /** Local jsonrepair function (defaults to npm jsonrepair). */
  jsonrepair?: (s: string) => string
  /** Logger for structured events. Defaults to console.log(JSON.stringify(...)). */
  log?: (event: Record<string, unknown>) => void
}

export type HealJsonResult =
  | { success: true; data: unknown; attempts: number }
  | { success: false; error: string; attempts: number; partial?: string }

/** Thrown when drift is unrecoverable after all retries. */
export class JsonDriftError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly partial?: string,
  ) {
    super(message)
    this.name = 'JsonDriftError'
  }
}

// ── Structured Logging ─────────────────────────────────────────────────

function defaultLog(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ...event, timestamp: new Date().toISOString() }))
}

// ── Repair Prompt Builder ──────────────────────────────────────────────

export function buildRepairPrompt(broken: string): Message[] {
  return [
    {
      role: 'system',
      content: `You are a JSON repair specialist. Given a malformed JSON string, output ONLY the corrected valid JSON. No explanation, no markdown, no code fences. Output must be parseable by JSON.parse().`,
    },
    {
      role: 'user',
      content: `Repair this malformed JSON:\n\n${broken}`,
    },
  ]
}

// ── Core healJson Function ─────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MODEL = 'fast' // Uses gateway's fastest available provider

export async function healJson(
  input: HealJsonInput,
  deps: HealJsonDeps = {},
): Promise<HealJsonResult> {
  const { jsonString, maxRetries = DEFAULT_MAX_RETRIES, model = DEFAULT_MODEL } = input
  const log = deps.log ?? defaultLog
  const localRepair = deps.jsonrepair ?? jsonrepair

  // 1. Try direct JSON.parse
  try {
    const data = JSON.parse(jsonString)
    return { success: true, data, attempts: 0 }
  } catch {
    // Expected — proceed to repair
  }

  log({ event: 'drift_detected', inputLength: jsonString.length })

  // 2. Try local jsonrepair
  try {
    const repaired = localRepair(jsonString)
    const data = JSON.parse(repaired)
    log({ event: 'drift_healed', method: 'local_jsonrepair', attempts: 0 })
    return { success: true, data, attempts: 0 }
  } catch {
    // Local repair failed — proceed to LLM
  }

  // 3. LLM repair loop
  if (!deps.callGateway) {
    const error = 'No gateway caller provided — cannot attempt LLM repair'
    log({ event: 'drift_failed', error, attempts: 0 })
    return { success: false, error, attempts: 0 }
  }

  let lastResponse: string | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log({ event: 'drift_healing', attempt, maxRetries, model })

    try {
      const messages = buildRepairPrompt(jsonString)
      const response = await deps.callGateway(model, messages)
      lastResponse = response

      // Try to parse the LLM's response
      try {
        const data = JSON.parse(response)
        log({ event: 'drift_healed', method: 'llm', attempts: attempt, model })
        return { success: true, data, attempts: attempt }
      } catch {
        // LLM returned non-JSON — try jsonrepair on the response
        try {
          const repairedResponse = localRepair(response)
          const data = JSON.parse(repairedResponse)
          log({ event: 'drift_healed', method: 'llm+jsonrepair', attempts: attempt, model })
          return { success: true, data, attempts: attempt }
        } catch {
          // Both failed — continue retry loop
          log({ event: 'drift_healing', attempt, status: 'parse_failed', model })
        }
      }
    } catch (err: unknown) {
      // Gateway call failed — immediate error, no retry
      const error = err instanceof Error ? err.message : String(err)
      log({ event: 'drift_failed', error, attempts: attempt, model, reason: 'gateway_error' })
      return { success: false, error: `Gateway error: ${error}`, attempts: attempt, partial: lastResponse }
    }
  }

  // All retries exhausted
  const error = `Failed to repair JSON after ${maxRetries} attempts`
  log({ event: 'drift_failed', error, attempts: maxRetries, model })
  return { success: false, error, attempts: maxRetries, partial: lastResponse }
}
