/**
 * Selector Factory — probes llama-cli + GGUF model availability and returns the best selector.
 *
 * When llama-cli binary exists and the GGUF model file is present, returns SLMSelector.
 * Otherwise falls back to HeuristicSelector with a console warning.
 * When `preferSlm: false`, skips the probe entirely.
 */

import { SLMSelector, type SLMSelectorConfig } from './slm-selector.ts'
import { HeuristicSelector, type Selector } from '../vault/src/selector.ts'
import {
  getDefaultModelPath,
  isLlamaBinaryAvailable,
  isModelAvailable,
} from './llama-client.ts'

export interface SelectorFactoryOptions {
  /** Prefer SLM-based selector when llama-cli is available. Default: true. */
  preferSlm?: boolean
  /** Path to the GGUF model file. Default: ~/.models/qwen2.5-0.5b-instruct-q4_k_m.gguf */
  modelPath?: string
  /** Path to llama-cli binary. Default: 'llama-cli' (resolved from PATH) */
  binaryPath?: string
  /** Inference timeout in milliseconds. Default: 500 */
  timeoutMs?: number
  /** Number of threads for llama-cli. Default: 4 */
  threads?: number
}

/**
 * Create a selector by probing llama-cli and GGUF model availability.
 *
 * Returns SLMSelector when llama-cli is found and the model file exists,
 * otherwise returns HeuristicSelector. The SLM selector's classify() returns
 * a Promise (async), while HeuristicSelector returns synchronously — callers
 * should handle both with `await`.
 */
export function createSelector(options: SelectorFactoryOptions = {}): Selector {
  const {
    preferSlm = true,
    modelPath = getDefaultModelPath(),
    binaryPath = 'llama-cli',
    timeoutMs = 500,
    threads = 4,
  } = options

  if (!preferSlm) {
    return new HeuristicSelector()
  }

  // Synchronous filesystem probe — no network I/O needed
  const binaryOk = isLlamaBinaryAvailable(binaryPath)
  const modelOk = isModelAvailable(modelPath)

  if (binaryOk && modelOk) {
    return new SLMSelector({
      modelPath,
      binaryPath,
      timeoutMs,
      threads,
    }) as unknown as Selector
  }

  if (!binaryOk) {
    console.warn(`[selector-factory] llama-cli binary not found: ${binaryPath}`)
  }
  if (!modelOk) {
    console.warn(`[selector-factory] GGUF model not found at: ${modelPath}`)
  }

  return new HeuristicSelector()
}

/**
 * Async factory — identical to createSelector() since the filesystem probe is sync.
 * Kept for API compatibility with callers that expect an async factory.
 */
export async function createSelectorAsync(options: SelectorFactoryOptions = {}): Promise<Selector> {
  return createSelector(options)
}
