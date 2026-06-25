/**
 * Gateway Pipeline Tests — Complex-request gating behavior.
 *
 * Tests the GATEWAY_USE_ENGRAM_PIPELINE opt-in gate that routes
 * COMPLEX classified requests to engram::orchestrate instead of
 * the direct provider fast-path.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// ── Mock Helpers ───────────────────────────────────────────────────────

function mockInvocation(body: unknown) {
  const written: string[] = []
  let closed = false
  let statusCode = 200
  let headers: Record<string, string> = {}
  const stream = new EventEmitter() as any
  stream.write = (data: string) => { written.push(data); return true }
  stream.end = (data?: string) => { if (data) written.push(data); closed = true; stream.emit('end') }
  stream.on = stream.on.bind(stream)
  stream.removeListener = stream.removeListener.bind(stream)

  const sendMessage = (msg: string) => {
    try {
      const parsed = JSON.parse(msg)
      if (parsed.type === 'set_status') statusCode = parsed.status_code
      if (parsed.type === 'set_headers') headers = { ...headers, ...parsed.headers }
    } catch { /* skip */ }
  }

  return {
    body,
    method: 'POST',
    path: '/v1/chat/completions',
    response: { sendMessage, stream, close: () => { closed = true } },
    _written: written,
    _closed: () => closed,
    _statusCode: () => statusCode,
    _headers: () => headers,
  }
}

function buildMockSdk(overrides: {
  resolveModel?: (model: string) => Promise<any>
  getKey?: (providerId: string) => Promise<string | null>
  callProvider?: (...args: any[]) => Promise<any>
  brainClassify?: (payload: any) => Promise<any>
  brainFails?: boolean
} = {}) {
  const triggerCalls: { function_id: string; payload: unknown }[] = []

  const iii: any = {
    trigger: async (opts: { function_id: string; payload: unknown }) => {
      triggerCalls.push(opts)

      if (opts.function_id === 'brain::classify') {
        if (overrides.brainFails) throw new Error('brain offline')
        if (overrides.brainClassify) return overrides.brainClassify(opts.payload)
        return { classification: 'SIMPLE', confidence: 0.9 }
      }
      if (opts.function_id === 'engram::orchestrate') {
        return { content: 'engram response' }
      }
      if (opts.function_id === 'translator::resolve') {
        if (overrides.resolveModel) return overrides.resolveModel((opts.payload as any).model)
        return { model: (opts.payload as any).model, providers: ['groq/gpt-4'], resolved: true }
      }
      if (opts.function_id === 'vault::retrieve') {
        if (overrides.getKey) {
          const key = await overrides.getKey((opts.payload as any).providerId)
          return { key }
        }
        return { key: 'sk-test' }
      }
      // Return success for telemetry / unknown triggers
      return { logged: true }
    },
    createChannel: async () => ({
      writer: { sendMessage() {}, close() {} },
      reader: { onMessage() {}, close() {}, stream: new EventEmitter() },
      writerRef: { channel_id: 'ch', access_key: 'k', direction: 'write' as const },
    }),
    registerFunction: () => ({ id: 'f', unregister() {} }),
    registerTrigger: () => ({ unregister() {} }),
    _triggerCalls: triggerCalls,
    _callProvider: overrides.callProvider,
  }

  return iii
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('gateway pipeline gating', () => {
  beforeEach(() => {
    delete process.env.GATEWAY_USE_ENGRAM_PIPELINE
  })

  it('off-mode (default): no brain::classify gate, direct provider used', async () => {
    // env var not set — gate is inactive
    const iii = buildMockSdk({
      callProvider: async () => ({ id: 'r-1', content: 'direct response', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    // Should return successfully via direct provider
    assert.equal(inv._statusCode(), 200)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.equal(body.choices[0].message.content, 'direct response')

    // No GATEWAY_* telemetry events should have fired
    const gatewayTelemetry = iii._triggerCalls.filter(
      (c: any) => c.function_id === 'log_event' &&
        (c.payload as any)?.eventClass?.startsWith('GATEWAY_'),
    )
    assert.equal(gatewayTelemetry.length, 0, 'no GATEWAY_* telemetry in off-mode')

    // brain::classify should still be called fire-and-forget
    const brainCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'brain::classify')
    assert.equal(brainCalls.length, 1, 'brain::classify called once (fire-and-forget)')
  })

  it('on-mode + SIMPLE: brain::classify called, fast-path used, telemetry emitted', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'SIMPLE', confidence: 0.9, source: 'heuristic' }),
      callProvider: async () => ({ id: 'r-2', content: 'fast path response', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    // Should return via fast-path provider
    assert.equal(inv._statusCode(), 200)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.equal(body.choices[0].message.content, 'fast path response')

    // brain::classify should have been called
    const brainCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'brain::classify')
    assert.equal(brainCalls.length, 1, 'brain::classify called once')

    // GATEWAY_CLASSIFY_DECISION and GATEWAY_FAST_PATH should be emitted
    const telemetryCalls = iii._triggerCalls.filter(
      (c: any) => c.function_id === 'log_event',
    )
    const eventClasses = telemetryCalls.map((c: any) => (c.payload as any)?.eventClass)
    assert.ok(eventClasses.includes('GATEWAY_CLASSIFY_DECISION'), 'GATEWAY_CLASSIFY_DECISION emitted')
    assert.ok(eventClasses.includes('GATEWAY_FAST_PATH'), 'GATEWAY_FAST_PATH emitted')

    // engram::orchestrate should NOT be called
    const engramCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'engram::orchestrate')
    assert.equal(engramCalls.length, 0, 'engram::orchestrate not called for SIMPLE')
  })

  it('on-mode + COMPLEX: brain::classify returns COMPLEX, engram::orchestrate called', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'COMPLEX', confidence: 0.75, source: 'heuristic' }),
      callProvider: async () => ({ id: 'r-3', content: 'should not reach provider', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Write a detailed analysis' },
        { role: 'assistant', content: 'Sure' },
        { role: 'user', content: 'Now expand on each point' },
      ],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    // Should return engram result, NOT direct provider
    assert.equal(inv._statusCode(), 200)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.equal(body.choices[0].message.content, 'engram response')

    // brain::classify should have been called
    const brainCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'brain::classify')
    assert.equal(brainCalls.length, 1, 'brain::classify called once')

    // engram::orchestrate should have been called
    const engramCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'engram::orchestrate')
    assert.equal(engramCalls.length, 1, 'engram::orchestrate called once')
    assert.ok(engramCalls[0].payload, 'engram::orchestrate received payload')
    assert.equal((engramCalls[0].payload as any).model, 'gpt-4')

    // GATEWAY_CLASSIFY_DECISION and GATEWAY_ENGRAM_PIPELINE_TRIGGERED should be emitted
    const telemetryCalls = iii._triggerCalls.filter(
      (c: any) => c.function_id === 'log_event',
    )
    const eventClasses = telemetryCalls.map((c: any) => (c.payload as any)?.eventClass)
    assert.ok(eventClasses.includes('GATEWAY_CLASSIFY_DECISION'), 'GATEWAY_CLASSIFY_DECISION emitted')
    assert.ok(eventClasses.includes('GATEWAY_ENGRAM_PIPELINE_TRIGGERED'), 'GATEWAY_ENGRAM_PIPELINE_TRIGGERED emitted')

    // GATEWAY_FAST_PATH should NOT be emitted for COMPLEX
    assert.ok(!eventClasses.includes('GATEWAY_FAST_PATH'), 'GATEWAY_FAST_PATH not emitted for COMPLEX')
  })

  it('telemetry events fire in the correct order for COMPLEX path', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'COMPLEX', confidence: 0.75, source: 'heuristic' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Explain quantum computing' },
        { role: 'assistant', content: 'Here is an explanation' },
        { role: 'user', content: 'Now make it more detailed' },
      ],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    // Get all trigger calls in order
    const allCalls = iii._triggerCalls
    const functionIds = allCalls.map((c: any) => c.function_id)
    const eventClasses = allCalls
      .filter((c: any) => c.function_id === 'log_event')
      .map((c: any) => (c.payload as any)?.eventClass)

    // Order: brain::classify → (telemetry: GATEWAY_CLASSIFY_DECISION) → engram::orchestrate → (telemetry: GATEWAY_ENGRAM_PIPELINE_TRIGGERED)
    const brainIdx = functionIds.indexOf('brain::classify')
    const engramIdx = functionIds.indexOf('engram::orchestrate')

    assert.ok(brainIdx < engramIdx, 'brain::classify before engram::orchestrate')

    // Check telemetry event order
    const classifyTelemetryIdx = eventClasses.indexOf('GATEWAY_CLASSIFY_DECISION')
    const engramTelemetryIdx = eventClasses.indexOf('GATEWAY_ENGRAM_PIPELINE_TRIGGERED')
    assert.ok(classifyTelemetryIdx < engramTelemetryIdx, 'GATEWAY_CLASSIFY_DECISION before GATEWAY_ENGRAM_PIPELINE_TRIGGERED')
  })

  it('classify failure in gate mode falls through to existing handler', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainFails: true,
      callProvider: async () => ({ id: 'r-4', content: 'fallback response', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    // Should fall through to direct provider successfully
    assert.equal(inv._statusCode(), 200)
    const body = JSON.parse(inv._written[inv._written.length - 1])
    assert.equal(body.choices[0].message.content, 'fallback response')

    // engran::orchestrate should NOT be called
    const engramCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'engram::orchestrate')
    assert.equal(engramCalls.length, 0, 'engram::orchestrate not called when brain fails')
  })

  it('on-mode + COMPLEX + streaming returns SSE from engram', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'COMPLEX', confidence: 0.75, source: 'heuristic' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Complex task' },
        { role: 'assistant', content: 'Part 1' },
        { role: 'user', content: 'Part 2 detailed' },
      ],
      stream: true,
    })

    const { createChatCompletionsHandler } = await import('./http-handler.ts')
    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)

    await new Promise(r => setTimeout(r, 200))

    // Should get SSE response from engram
    assert.equal(inv._statusCode(), 200)
    const headers = inv._headers()
    assert.equal(headers['content-type'], 'text/event-stream')

    // Should have at least data chunk + [DONE]
    const dataLines = inv._written.filter((w: string) => w.startsWith('data: '))
    assert.ok(dataLines.length >= 2, 'should have SSE data lines')
    assert.ok(dataLines[dataLines.length - 1].includes('[DONE]'), 'last line should be [DONE]')

    // Parse chunk to verify content
    const firstLine = dataLines[0]
    const parsed = JSON.parse(firstLine.slice(6))
    assert.equal(parsed.object, 'chat.completion.chunk')
    assert.equal(parsed.choices[0].delta.content, 'engram response')
    assert.equal(parsed.choices[0].finish_reason, 'stop')
  })
})
