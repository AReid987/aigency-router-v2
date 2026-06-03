/**
 * Pipeline — Composable processing stages for Engram.
 *
 * R013: Engram designed as a pipeline interface supporting the full
 * decomposition flow. M001 implements drift correction only; the
 * interface accommodates future stages (decompose, distribute, quality
 * gates, peer review, LLM-as-Judge) without rearchitecting in M003.
 */

import { healJson, type HealJsonDeps, type HealJsonInput } from './heal-json.js'

// ── Pipeline Interfaces ────────────────────────────────────────────────

export interface PipelineContext {
  requestId: string
  metadata: Record<string, unknown>
  log: (event: string, data?: unknown) => void
}

export interface PipelineStage {
  name: string
  process(input: unknown, context: PipelineContext): Promise<unknown>
}

export type PipelineResult =
  | { success: true; data: unknown; stages: string[] }
  | { success: false; error: string; failedStage: string }

// ── EngramPipeline ─────────────────────────────────────────────────────

export class EngramPipeline {
  private readonly stages: PipelineStage[] = []

  addStage(stage: PipelineStage): this {
    this.stages.push(stage)
    return this
  }

  get stageNames(): string[] {
    return this.stages.map((s) => s.name)
  }

  async process(
    input: unknown,
    context: PipelineContext,
  ): Promise<PipelineResult> {
    if (this.stages.length === 0) {
      return { success: true, data: input, stages: [] }
    }

    const executed: string[] = []
    let current: unknown = input

    for (const stage of this.stages) {
      try {
        current = await stage.process(current, context)
        executed.push(stage.name)
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err)
        return { success: false, error, failedStage: stage.name }
      }
    }

    return { success: true, data: current, stages: executed }
  }
}

// ── DriftCorrectorStage ────────────────────────────────────────────────

export interface DriftCorrectorConfig {
  maxRetries?: number
  model?: string
  deps?: HealJsonDeps
}

export class DriftCorrectorStage implements PipelineStage {
  readonly name = 'drift_corrector'
  private readonly maxRetries: number
  private readonly model: string
  private readonly deps: HealJsonDeps

  constructor(config: DriftCorrectorConfig = {}) {
    this.maxRetries = config.maxRetries ?? 3
    this.model = config.model ?? 'fast'
    this.deps = config.deps ?? {}
  }

  async process(input: unknown, context: PipelineContext): Promise<unknown> {
    // Input must be a string (malformed JSON)
    if (typeof input !== 'string') {
      throw new Error(
        `DriftCorrectorStage expects string input, got ${typeof input}`,
      )
    }

    context.log('drift_corrector:start', {
      inputLength: input.length,
      requestId: context.requestId,
    })

    const healInput: HealJsonInput = {
      jsonString: input,
      maxRetries: this.maxRetries,
      model: this.model,
    }

    const result = await healJson(healInput, this.deps)

    if (result.success) {
      context.log('drift_corrector:complete', {
        attempts: result.attempts,
        requestId: context.requestId,
      })
      return result.data
    }

    // Propagate failure as an error
    throw new Error(`Drift correction failed: ${result.error}`)
  }
}
