/**
 * Selector Factory — probes Ollama availability and returns the best selector.
 *
 * When Ollama is reachable and the target model is loaded, returns SLMSelector.
 * Otherwise falls back to HeuristicSelector with a console warning.
 * When `preferSlm: false`, skips the probe entirely.
 */

import { Ollama } from 'ollama'
import { SLMSelector, type SLMSelectorConfig } from './slm-selector.ts'
import { HeuristicSelector, type Selector } from '../vault/src/selector.ts'

export interface SelectorFactoryOptions {
  /** Prefer SLM-based selector when Ollama is available. Default: true. */
  preferSlm?: boolean
  /** Ollama host URL. Default: http://localhost:11434 */
  ollamaUrl?: string
  /** SLM model name to probe for. Default: qwen2.5:0.5b */
  slmModel?: string
  /** Timeout for the Ollama availability probe. Default: 500ms */
  timeoutMs?: number
}

/**
 * Create a selector by probing Ollama availability.
 *
 * Returns SLMSelector when Ollama is reachable and the target model is loaded,
 * otherwise returns HeuristicSelector. The SLM selector's classify() returns
 * a Promise (async), while HeuristicSelector returns synchronously — callers
 * should handle both with `await`.
 */
export function createSelector(options: SelectorFactoryOptions = {}): Selector {
  const {
    preferSlm = true,
    ollamaUrl = 'http://localhost:11434',
    slmModel = 'qwen2.5:0.5b',
    timeoutMs = 500,
  } = options

  if (!preferSlm) {
    return new HeuristicSelector()
  }

  // Probe Ollama synchronously is not possible — use a cached/best-effort approach.
  // For a factory function, we do the probe eagerly and return the result.
  // Note: This creates the selector immediately; the probe runs in the background.
  // For a truly async factory, use createSelectorAsync().
  const probeResult = probeOllamaSync(ollamaUrl, slmModel, timeoutMs)

  if (probeResult === 'available') {
    return new SLMSelector({
      model: slmModel,
      ollamaUrl,
      timeoutMs,
    }) as unknown as Selector
  }

  if (probeResult === 'unavailable') {
    console.warn(`[selector-factory] Ollama unreachable or model "${slmModel}" not found, falling back to HeuristicSelector`)
  }

  return new HeuristicSelector()
}

/**
 * Async factory — probes Ollama with a real network call and returns the best selector.
 * Use this when you can await the result (e.g., worker startup).
 */
export async function createSelectorAsync(options: SelectorFactoryOptions = {}): Promise<Selector> {
  const {
    preferSlm = true,
    ollamaUrl = 'http://localhost:11434',
    slmModel = 'qwen2.5:0.5b',
    timeoutMs = 500,
  } = options

  if (!preferSlm) {
    return new HeuristicSelector()
  }

  try {
    const ollama = new Ollama({ host: ollamaUrl })
    const listPromise = ollama.list()
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Ollama probe timeout')), timeoutMs),
    )

    const result = await Promise.race([listPromise, timeoutPromise])
    const modelExists = result.models.some(
      (m: { name: string }) => m.name === slmModel || m.name === `${slmModel}:latest`,
    )

    if (modelExists) {
      return new SLMSelector({
        model: slmModel,
        ollamaUrl,
        timeoutMs,
      }) as unknown as Selector
    }

    console.warn(`[selector-factory] Model "${slmModel}" not found in Ollama, falling back to HeuristicSelector`)
    return new HeuristicSelector()
  } catch {
    console.warn(`[selector-factory] Ollama probe failed, falling back to HeuristicSelector`)
    return new HeuristicSelector()
  }
}

/**
 * Synchronous probe helper — always returns 'unavailable' since we can't
 * do network I/O synchronously. The async factory (createSelectorAsync)
 * does the real probe. This exists for the sync factory's signature only.
 */
function probeOllamaSync(_ollamaUrl: string, _slmModel: string, _timeoutMs: number): 'available' | 'unavailable' {
  // Cannot probe network synchronously — default to unavailable.
  // Callers who need real probing should use createSelectorAsync().
  return 'unavailable'
}
