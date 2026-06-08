/**
 * SLMSelector — local SLM-backed classifier using Ollama.
 *
 * Wraps a small language model (default: qwen2.5:0.5b) to classify requests
 * as 'simple' or 'complex'. Falls back on timeout or error (caller handles).
 *
 * Requirements: Ollama running locally (default http://localhost:11434).
 */

import { Ollama } from 'ollama'
import type { ModelRequest, Classification } from '../vault/src/selector.ts'
import { logTelemetry, type TelemetryDeps } from './telemetry.ts'

export interface SLMSelectorConfig {
  model?: string
  ollamaUrl?: string
  timeoutMs?: number
  telemetryDeps?: TelemetryDeps
  sourceWorker?: string
}

export class SLMSelector {
  private readonly ollama: Ollama
  private readonly model: string
  private readonly timeoutMs: number
  private readonly telemetryDeps?: TelemetryDeps
  private readonly sourceWorker: string

  constructor(config: SLMSelectorConfig = {}) {
    this.model = config.model ?? 'qwen2.5:0.5b'
    this.ollama = new Ollama({ host: config.ollamaUrl ?? 'http://localhost:11434' })
    this.timeoutMs = config.timeoutMs ?? 500
    this.telemetryDeps = config.telemetryDeps
    this.sourceWorker = config.sourceWorker ?? 'slm-selector'
  }

  /**
   * Classify a model request via local SLM.
   *
   * @throws {Error} on timeout, malformed JSON, or Ollama connection failure.
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

    const callPromise = this.ollama.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      format: 'json',
      stream: false,
    })

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SLM classification timeout')), this.timeoutMs),
    )

    let response: Awaited<typeof callPromise>
    try {
      response = await Promise.race([callPromise, timeoutPromise])
    } catch (err: unknown) {
      const latencyMs = Date.now() - start
      const msg = err instanceof Error ? err.message : String(err)

      if (msg.includes('timeout') || msg.includes('abort')) {
        throw new Error(`SLM classification timeout after ${latencyMs}ms`)
      }
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('connect')) {
        throw new Error(`Ollama connection refused: ${msg}`)
      }
      throw new Error(`Ollama error: ${msg}`)
    }

    const latencyMs = Date.now() - start

    // Parse structured JSON response
    let parsed: { classification?: string; reason?: string }
    try {
      parsed = JSON.parse(response.message.content)
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
          model: this.model,
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
