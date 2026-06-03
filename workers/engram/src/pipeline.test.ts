/**
 * pipeline.test.ts — Tests for EngramPipeline and DriftCorrectorStage.
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  EngramPipeline,
  DriftCorrectorStage,
  type PipelineContext,
  type PipelineStage,
} from './pipeline.js'

// ── Helpers ────────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    requestId: 'req-001',
    metadata: {},
    log: mock.fn(),
    ...overrides,
  }
}

function makeStage(
  name: string,
  fn: (input: unknown) => unknown | Promise<unknown>,
): PipelineStage {
  return {
    name,
    process: async (input: unknown) => fn(input),
  }
}

// ── EngramPipeline ─────────────────────────────────────────────────────

describe('EngramPipeline', () => {
  it('returns input unchanged when pipeline has zero stages', async () => {
    const pipeline = new EngramPipeline()
    const ctx = makeContext()
    const result = await pipeline.process('hello', ctx)
    assert.deepStrictEqual(result, { success: true, data: 'hello', stages: [] })
  })

  it('executes a single stage in registration order', async () => {
    const pipeline = new EngramPipeline()
    const doubler = makeStage('doubler', (input) => (input as number) * 2)
    pipeline.addStage(doubler)
    const ctx = makeContext()
    const result = await pipeline.process(5, ctx)
    assert.deepStrictEqual(result, { success: true, data: 10, stages: ['doubler'] })
  })

  it('executes multiple stages in registration order', async () => {
    const pipeline = new EngramPipeline()
    const toString = makeStage('to_string', (input) => String(input))
    const wrap = makeStage('wrap', (input) => `[${input}]`)
    pipeline.addStage(toString)
    pipeline.addStage(wrap)
    const ctx = makeContext()
    const result = await pipeline.process(42, ctx)
    assert.deepStrictEqual(result, {
      success: true,
      data: '[42]',
      stages: ['to_string', 'wrap'],
    })
  })

  it('propagates stage errors and reports failed stage', async () => {
    const pipeline = new EngramPipeline()
    const ok = makeStage('ok', (input) => input)
    const fail = makeStage('boom', () => {
      throw new Error('stage exploded')
    })
    pipeline.addStage(ok)
    pipeline.addStage(fail)
    pipeline.addStage(makeStage('never', (input) => input))
    const ctx = makeContext()
    const result = await pipeline.process('x', ctx)
    assert.deepStrictEqual(result, {
      success: false,
      error: 'stage exploded',
      failedStage: 'boom',
    })
  })

  it('passes context through to stages', async () => {
    const pipeline = new EngramPipeline()
    let receivedCtx: PipelineContext | undefined
    const spy: PipelineStage = {
      name: 'spy',
      process: async (_input, ctx) => {
        receivedCtx = ctx
        return 'ok'
      },
    }
    pipeline.addStage(spy)
    const ctx = makeContext({ requestId: 'ctx-test', metadata: { key: 'val' } })
    await pipeline.process('x', ctx)
    assert.strictEqual(receivedCtx?.requestId, 'ctx-test')
    assert.deepStrictEqual(receivedCtx?.metadata, { key: 'val' })
  })

  it('returns empty stages array when addStage returns this for chaining', () => {
    const pipeline = new EngramPipeline()
    const result = pipeline
      .addStage(makeStage('a', (i) => i))
      .addStage(makeStage('b', (i) => i))
    assert.strictEqual(result, pipeline)
    assert.deepStrictEqual(pipeline.stageNames, ['a', 'b'])
  })
})

// ── DriftCorrectorStage ────────────────────────────────────────────────

describe('DriftCorrectorStage', () => {
  it('wraps healJson and returns parsed data on valid input', async () => {
    const mockLog = mock.fn()
    const mockHealJson = mock.fn(async () => ({
      success: true as const,
      data: { ok: true },
      attempts: 0,
    }))

    const stage = new DriftCorrectorStage({
      deps: {
        callGateway: async () => '{}',
        jsonrepair: (s: string) => s,
        log: mockHealJson,
      },
    })

    const ctx = makeContext({ log: mockLog })
    const result = await stage.process('{"ok":true}', ctx)
    assert.deepStrictEqual(result, { ok: true })
  })

  it('throws on non-string input', async () => {
    const stage = new DriftCorrectorStage()
    const ctx = makeContext()
    await assert.rejects(
      () => stage.process(123, ctx),
      { message: /DriftCorrectorStage expects string input, got number/ },
    )
  })

  it('throws on null input', async () => {
    const stage = new DriftCorrectorStage()
    const ctx = makeContext()
    await assert.rejects(
      () => stage.process(null, ctx),
      { message: /DriftCorrectorStage expects string input, got object/ },
    )
  })

  it('propagates healJson failure as an error', async () => {
    const stage = new DriftCorrectorStage({
      maxRetries: 1,
      deps: {
        // No callGateway — healJson will fail with "No gateway caller"
        jsonrepair: () => {
          throw new Error('local repair failed')
        },
      },
    })
    const ctx = makeContext()
    await assert.rejects(
      () => stage.process('{broken', ctx),
      { message: /Drift correction failed/ },
    )
  })

  it('delegates to healJson with correct config', async () => {
    const mockCallGateway = mock.fn(async () => '{"fixed":true}')
    const stage = new DriftCorrectorStage({
      maxRetries: 2,
      model: 'test-model',
      deps: {
        callGateway: mockCallGateway,
        jsonrepair: () => {
          throw new Error('force LLM path')
        },
      },
    })
    const ctx = makeContext()
    const result = await stage.process('{broken', ctx)
    // healJson should have used the LLM path
    assert.deepStrictEqual(result, { fixed: true })
  })
})
