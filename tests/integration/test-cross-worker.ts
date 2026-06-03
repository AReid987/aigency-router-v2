/**
 * Cross-worker integration tests — TypeScript side.
 *
 * Verifies that a TypeScript worker can call:
 *   1. brain::classify  (TS → Python)
 *   2. gateway::echo    (TS → TS)
 *
 * Prerequisites: iii engine + all workers must be running.
 * Run: npx tsx test-cross-worker.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

let iii: ReturnType<typeof registerWorker>

before(async () => {
  iii = registerWorker(ENGINE_URL, { workerName: 'integration-test-ts' })
  // Give the worker a moment to register
  await new Promise((r) => setTimeout(r, 500))
})

after(async () => {
  await iii.shutdown()
})

describe('Cross-worker function calls (TypeScript)', () => {
  it('should call brain::classify and get a valid classification', async () => {
    const result = await iii.trigger<
      { model: string; messages: Array<{ role: string; content: string }> },
      { classification: string; confidence: number; model: string; message_count: number }
    >({
      function_id: 'brain::classify',
      payload: {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      },
      timeoutMs: 5000,
    })

    assert.ok(result, 'result should not be null')
    assert.equal(result.classification, 'SIMPLE')
    assert.equal(result.model, 'gpt-4')
    assert.equal(result.message_count, 1)
    assert.ok(typeof result.confidence === 'number')
    assert.ok(result.confidence > 0)
  })

  it('should call gateway::echo and get echo response', async () => {
    const result = await iii.trigger<
      { message: string },
      { echo: string; worker: string; timestamp: number }
    >({
      function_id: 'gateway::echo',
      payload: { message: 'integration-test-ping' },
      timeoutMs: 5000,
    })

    assert.ok(result, 'result should not be null')
    assert.equal(result.echo, 'integration-test-ping')
    assert.equal(result.worker, 'gateway')
    assert.ok(typeof result.timestamp === 'number')
  })

  it('should call brain::status and get healthy response', async () => {
    const result = await iii.trigger<Record<string, never>, { status: string; worker: string }>(
      {
        function_id: 'brain::status',
        payload: {},
        timeoutMs: 5000,
      },
    )

    assert.ok(result, 'result should not be null')
    assert.equal(result.status, 'healthy')
    assert.equal(result.worker, 'brain')
  })
})
