/**
 * SLMSelector — local SLM-backed classifier using llama-cli.
 *
 * Wraps a small language model (default: qwen2.5-0.5b-instruct-q4_k_m)
 * to classify requests as 'simple' or 'complex'. Falls back on timeout
 * or error (caller handles).
 *
 * Requirements: llama-cli binary on PATH, GGUF model file at configured path.
 */

import {
  classifyViaLlama,
  getDefaultModelPath,
  isLlamaBinaryAvailable,
  isModelAvailable,
  type LlamaClientConfig,
} from './llama-client.ts'
import type { ModelRequest, Classification } from '../vault/src/selector.ts'
import { logTelemetry, type TelemetryDeps } from './telemetry.ts'

export interface SLMSelectorConfig {
  /** Path to the GGUF model file. Default: ~/.models/qwen2.5-0.5b-instruct-q4_k_m.gguf */
  modelPath?: string
  /** Inference timeout in milliseconds. Default: 500 */
  timeoutMs?: number
  /** Path to llama-cli binary. Default: 'llama-cli' (resolved from PATH) */
  binaryPath?: string
  /** Number of threads for llama-cli. Default: 4 */
  threads?: number
  telemetryDeps?: TelemetryDeps
  sourceWorker?: string
}

export class SLMSelector {
  private readonly modelPath: string
  private readonly timeoutMs: number
  private readonly binaryPath: string
  private readonly threads: number
  private readonly telemetryDeps?: TelemetryDeps
  private readonly sourceWorker: string

  constructor(config: SLMSelectorConfig = {}) {
    this.modelPath = config.modelPath ?? getDefaultModelPath()
    this.binaryPath = config.binaryPath ?? 'llama-cli'
    this.threads = config.threads ?? 4
    this.timeoutMs = config.timeoutMs ?? 500
    this.telemetryDeps = config.telemetryDeps
    this.sourceWorker = config.sourceWorker ?? 'slm-selector'
  }

  /**
   * Check if the SLM is available (binary exists + model file exists).
   */
  isAvailable(): boolean {
    return isLlamaBinaryAvailable(this.binaryPath) && isModelAvailable(this.modelPath)
  }

  /**
   * Classify a model request via local SLM.
   *
   * @throws {Error} on timeout, malformed JSON, or llama-cli spawn failure.
   */
  async classify(request: ModelRequest): Promise<Classification> {
    const messageCount = request.messages?.length ?? 0
    const totalContentLength = request.messages?.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) ?? 0
    const enforceJson = request.enforce_json === true
    const maxTokens = request.max_tokens ?? 'unset'

    const prompt = [
      'Classify the following LLM request as "simple" or "complex".',
      `Messages: ${messageCount}`,
      `Total content length: ${totalContentLength} chars`,
      `Enforce JSON: ${enforceJson}`,
      `Max tokens: ${maxTokens}`,
      '',
      'Respond with JSON: {"classification": "simple"|"complex", "reason": "..."}',
    ].join('\n')

    const start = Date.now()

    let jsonStr: string
    try {
      jsonStr = await classifyViaLlama(this.modelPath, prompt, {
        binaryPath: this.binaryPath,
        timeoutMs: this.timeoutMs,
        threads: this.threads,
      })
    } catch (err: unknown) {
      const latencyMs = Date.now() - start
      const msg = err instanceof Error ? err.message : String(err)

      if (msg.includes('timeout')) {
        throw new Error(`SLM classification timeout after ${latencyMs}ms`)
      }
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        throw new Error(`llama-cli binary not found: ${this.binaryPath}`)
      }
      throw new Error(`llama-cli error: ${msg}`)
    }

    const latencyMs = Date.now() - start

    // Parse structured JSON response
    let parsed: { classification?: string; reason?: string }
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      throw new Error('SLM returned malformed JSON')
    }

    if (parsed.classification !== 'simple' && parsed.classification !== 'complex') {
      throw new Error(`SLM returned invalid classification: ${parsed.classification}`)
    }

    const classification = parsed.classification as Classification

    // Emit telemetry
    if (this.telemetryDeps) {
      await logTelemetry(this.telemetryDeps, {
        eventClass: 'SLM_CLASSIFY',
        sourceWorker: this.sourceWorker,
        payload: {
          model: 'qwen2.5-0.5b-instruct-q4_k_m',
          latencyMs,
          classification,
          requestMessageCount: messageCount,
          reason: parsed.reason,
        },
      })
    }

    return classification
  }
}
