/**
 * test-gateway-pipeline — Integration test for gateway + Engram pipeline.
 *
 * Exercises the full chain: HTTP request -> brain classify -> engram
 * orchestrate -> OpenAI-format response. Mocks the iii-sdk worker
 * functions (brain::classify, engram::orchestrate, translator::resolve,
 * vault::retrieve) but tests the gateway's HTTP handler end-to-end.
 *
 * Extends the unit-level gateway-pipeline.test.ts by:
 *   - Testing OpenAI response format compliance in detail
 *   - Testing engram::orchestrate failure with fallback to direct provider
 *   - Testing routeLlm with engram pipeline integration
 *
 * Run: npx tsx tests/integration/test-gateway-pipeline.ts
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createChatCompletionsHandler } from '../../workers/gateway/src/http-handler.ts'

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
  engramOrchestrate?: (payload: any) => Promise<any>
  engramFails?: boolean
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
        if (overrides.engramFails) throw new Error('pipeline failure')
        if (overrides.engramOrchestrate) return overrides.engramOrchestrate(opts.payload)
        return { content: 'engram response', finishReason: 'stop' }
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

/**
 * Parse the OpenAI response body from the written output.
 */
function parseResponse(written: string[]): any {
  const last = written[written.length - 1]
  if (!last) throw new Error('no written output')
  return JSON.parse(last)
}

/**
 * Parse SSE chunks from written output.
 */
function parseSSEChunks(written: string[]): any[] {
  return written
    .filter((w) => w.startsWith('data: ') && !w.includes('[DONE]'))
    .map((w) => JSON.parse(w.slice(6)))
}

// ── Helpers to assert OpenAI format compliance ─────────────────────────

/**
 * Assert that a response object conforms to the OpenAI chat completion format.
 */
function assertOpenAIFormat(response: any): void {
  assert.ok(response.id, 'response must have id')
  assert.ok(response.id.startsWith('chatcmpl-'), `id must start with chatcmpl-, got ${response.id}`)
  assert.equal(response.object, 'chat.completion', `object must be chat.completion, got ${response.object}`)
  assert.ok(typeof response.created === 'number', 'created must be a number')
  assert.ok(response.model, 'response must have model')
  assert.ok(Array.isArray(response.choices), 'choices must be an array')
}

/**
 * Assert a single OpenAI choice has the correct shape.
 */
function assertOpenAIChoice(choice: any, expectedContent: string): void {
  assert.equal(typeof choice.index, 'number', 'choice must have numeric index')
  assert.ok(choice.message, 'choice must have message')
  assert.equal(choice.message.role, 'assistant', 'message role must be assistant')
  assert.equal(choice.message.content, expectedContent, `message content mismatch: expected "${expectedContent}", got "${choice.message.content}"`)
  assert.equal(choice.finish_reason, 'stop', 'finish_reason must be stop')
}

/**
 * Assert OpenAI usage object shape.
 */
function assertOpenAIUsage(usage: any): void {
  assert.ok(usage, 'response must have usage')
  assert.equal(typeof usage.prompt_tokens, 'number', 'usage.prompt_tokens must be number')
  assert.equal(typeof usage.completion_tokens, 'number', 'usage.completion_tokens must be number')
  assert.equal(typeof usage.total_tokens, 'number', 'usage.total_tokens must be number')
}

// ── Test Suite ─────────────────────────────────────────────────────────

describe('Gateway Pipeline Integration', () => {
  beforeEach(() => {
    delete process.env.GATEWAY_USE_ENGRAM_PIPELINE
  })

  // ── Test 1: SIMPLE request — fast-path unchanged ───────────────────

  it('(1) SIMPLE request via /v1/chat/completions provides fast-path unchanged', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'SIMPLE', confidence: 0.9, source: 'heuristic' }),
      callProvider: async () => ({ id: 'r-1', content: 'fast path response', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
    })

    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 200))

    // (a) Response is 200
    assert.equal(inv._statusCode(), 200)

    // (b) brain::classify was called
    const brainCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'brain::classify')
    assert.equal(brainCalls.length, 1, 'brain::classify must be called')

    // (c) engram::orchestrate was NOT called
    const engramCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'engram::orchestrate')
    assert.equal(engramCalls.length, 0, 'engram::orchestrate must NOT be called for SIMPLE')

    // (d) Response is OpenAI format with direct provider content
    const response = parseResponse(inv._written)
    assertOpenAIFormat(response)
    assertOpenAIChoice(response.choices[0], 'fast path response')
    assertOpenAIUsage(response.usage!)

    // (e) Telemetry events: GATEWAY_CLASSIFY_DECISION + GATEWAY_FAST_PATH
    const telemetryCalls = iii._triggerCalls.filter(
      (c: any) => c.function_id === 'log_event',
    )
    const eventClasses = telemetryCalls.map((c: any) => (c.payload as any)?.eventClass)
    assert.ok(eventClasses.includes('GATEWAY_CLASSIFY_DECISION'), 'GATEWAY_CLASSIFY_DECISION must be emitted')
    assert.ok(eventClasses.includes('GATEWAY_FAST_PATH'), 'GATEWAY_FAST_PATH must be emitted for SIMPLE')
    assert.ok(!eventClasses.includes('GATEWAY_ENGRAM_PIPELINE_TRIGGERED'), 'GATEWAY_ENGRAM_PIPELINE_TRIGGERED must NOT be emitted for SIMPLE')
  })

  // ── Test 2: COMPLEX request — pipeline triggered ───────────────────

  it('(2) COMPLEX request triggers engram::orchestrate and returns OpenAI-format response', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const engramPayloads: any[] = []

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'COMPLEX', confidence: 0.75, source: 'heuristic' }),
      engramOrchestrate: async (payload: any) => {
        engramPayloads.push(payload)
        return {
          content: 'Aggregated pipeline result from DAG + distribute + gates + peer review',
          finishReason: 'stop',
          metadata: {
            stagesCompleted: 3,
            peerReviewConsensus: 0.85,
            gatesPassed: 4,
            gatesFailed: 0,
            retriesUsed: 0,
            nodeCount: 4,
            dagId: 'root',
          },
        }
      },
      callProvider: async () => ({ id: 'r-2', content: 'should not reach provider', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Write a detailed analysis of quantum computing' },
        { role: 'assistant', content: 'Sure, here is an overview' },
        { role: 'user', content: 'Now expand on each concept in detail' },
      ],
    })

    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 200))

    // (a) Response is 200
    assert.equal(inv._statusCode(), 200)

    // (b) brain::classify was called
    const brainCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'brain::classify')
    assert.equal(brainCalls.length, 1, 'brain::classify must be called')

    // (c) engram::orchestrate was called with correct payload
    const engramCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'engram::orchestrate')
    assert.equal(engramCalls.length, 1, 'engram::orchestrate must be called for COMPLEX')
    assert.equal((engramCalls[0].payload as any).model, 'gpt-4')
    assert.ok(Array.isArray((engramCalls[0].payload as any).messages), 'engram::orchestrate must receive messages')

    // (d) Direct provider was NOT called (engram pipeline short-circuits)
    const resolveCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'translator::resolve')
    assert.equal(resolveCalls.length, 0, 'translator::resolve must NOT be called when engram pipeline handles COMPLEX')

    // (e) Response is OpenAI format with engram result as content
    const response = parseResponse(inv._written)
    assertOpenAIFormat(response)
    assert.equal(response.model, 'gpt-4')
    assertOpenAIChoice(response.choices[0], 'Aggregated pipeline result from DAG + distribute + gates + peer review')

    // (f) Telemetry events
    const telemetryCalls = iii._triggerCalls.filter(
      (c: any) => c.function_id === 'log_event',
    )
    const eventClasses = telemetryCalls.map((c: any) => (c.payload as any)?.eventClass)
    assert.ok(eventClasses.includes('GATEWAY_CLASSIFY_DECISION'), 'GATEWAY_CLASSIFY_DECISION must be emitted')
    assert.ok(eventClasses.includes('GATEWAY_ENGRAM_PIPELINE_TRIGGERED'), 'GATEWAY_ENGRAM_PIPELINE_TRIGGERED must be emitted for COMPLEX')
    assert.ok(!eventClasses.includes('GATEWAY_FAST_PATH'), 'GATEWAY_FAST_PATH must NOT be emitted for COMPLEX')
  })

  // ── Test 3: Telemetry event ordering ───────────────────────────────

  it('(3) Telemetry events fire in the correct order', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'COMPLEX', confidence: 0.75, source: 'heuristic' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Explain quantum entanglement' },
        { role: 'assistant', content: 'Here is the explanation' },
        { role: 'user', content: 'Now make it more accessible to beginners' },
      ],
    })

    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 200))

    // Get all trigger calls in order
    const functionIds = iii._triggerCalls.map((c: any) => c.function_id)
    const eventClasses = iii._triggerCalls
      .filter((c: any) => c.function_id === 'log_event')
      .map((c: any) => (c.payload as any)?.eventClass)

    // (a) Order: brain::classify must come before engram::orchestrate
    const brainIdx = functionIds.indexOf('brain::classify')
    const engramIdx = functionIds.indexOf('engram::orchestrate')
    assert.ok(brainIdx >= 0, 'brain::classify must be in trigger calls')
    assert.ok(engramIdx >= 0, 'engram::orchestrate must be in trigger calls')
    assert.ok(brainIdx < engramIdx, 'brain::classify must precede engram::orchestrate')

    // (b) Telemetry event order: GATEWAY_CLASSIFY_DECISION before GATEWAY_ENGRAM_PIPELINE_TRIGGERED
    const classifyTelemetryIdx = eventClasses.indexOf('GATEWAY_CLASSIFY_DECISION')
    const pipelineTelemetryIdx = eventClasses.indexOf('GATEWAY_ENGRAM_PIPELINE_TRIGGERED')
    assert.ok(classifyTelemetryIdx >= 0, 'GATEWAY_CLASSIFY_DECISION must be in telemetry')
    assert.ok(pipelineTelemetryIdx >= 0, 'GATEWAY_ENGRAM_PIPELINE_TRIGGERED must be in telemetry')
    assert.ok(classifyTelemetryIdx < pipelineTelemetryIdx, 'GATEWAY_CLASSIFY_DECISION must precede GATEWAY_ENGRAM_PIPELINE_TRIGGERED')

    // (c) For SIMPLE path: GATEWAY_CLASSIFY_DECISION before GATEWAY_FAST_PATH
    // (tested in a separate SIMPLE test below)
  })

  it('(3b) SIMPLE path telemetry ordering: CLASSIFY_DECISION before FAST_PATH', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'SIMPLE', confidence: 0.95, source: 'heuristic' }),
      callProvider: async () => ({ id: 'r-3', content: 'simple', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 200))

    const eventClasses = iii._triggerCalls
      .filter((c: any) => c.function_id === 'log_event')
      .map((c: any) => (c.payload as any)?.eventClass)

    const classifyIdx = eventClasses.indexOf('GATEWAY_CLASSIFY_DECISION')
    const fastPathIdx = eventClasses.indexOf('GATEWAY_FAST_PATH')

    assert.ok(classifyIdx >= 0, 'GATEWAY_CLASSIFY_DECISION must fire')
    assert.ok(fastPathIdx >= 0, 'GATEWAY_FAST_PATH must fire for SIMPLE')
    assert.ok(classifyIdx < fastPathIdx, 'GATEWAY_CLASSIFY_DECISION must precede GATEWAY_FAST_PATH')
  })

  // ── Test 4: OpenAI format compatibility ────────────────────────────

  it('(4a) OpenAI format: JSON response has all required fields for non-streaming COMPLEX', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'COMPLEX', confidence: 0.75 }),
      engramOrchestrate: async () => ({
        content: 'Pipeline result',
        finishReason: 'stop',
        metadata: { stagesCompleted: 2, peerReviewConsensus: 0.9, gatesPassed: 3, gatesFailed: 0, retriesUsed: 0, nodeCount: 3 },
      }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Complex multi-step analysis' },
        { role: 'assistant', content: 'Ok' },
        { role: 'user', content: 'Continue' },
      ],
    })

    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 200))

    assert.equal(inv._statusCode(), 200)
    assert.equal(inv._headers()['content-type'], 'application/json')

    const response = parseResponse(inv._written)

    // Full OpenAI format compliance
    assertOpenAIFormat(response)

    // id: starts with chatcmpl-
    assert.match(response.id, /^chatcmpl-/)

    // object: chat.completion
    assert.equal(response.object, 'chat.completion')

    // created: Unix timestamp (reasonable range)
    assert.ok(response.created > 1700000000, 'created must be a recent Unix timestamp')
    assert.ok(response.created < 2000000000, 'created must be within range')

    // model: must match request
    assert.equal(response.model, 'gpt-4')

    // choices: array with single element
    assert.equal(response.choices.length, 1)
    assertOpenAIChoice(response.choices[0], 'Pipeline result')

    // usage: NOT present for engram pipeline (not measured)
    // The engram pipeline response does not include usage
  })

  it('(4b) OpenAI format: SSE streaming for COMPLEX request', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'COMPLEX', confidence: 0.75 }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Complex streaming task' },
        { role: 'assistant', content: 'Intermediate' },
        { role: 'user', content: 'Final details' },
      ],
      stream: true,
    })

    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 200))

    // SSE headers
    assert.equal(inv._statusCode(), 200)
    assert.equal(inv._headers()['content-type'], 'text/event-stream')
    assert.equal(inv._headers()['cache-control'], 'no-cache')
    assert.equal(inv._headers()['connection'], 'keep-alive')

    // SSE body: data chunks + [DONE]
    const dataLines = inv._written.filter((w: string) => w.startsWith('data: '))
    assert.ok(dataLines.length >= 2, 'SSE must have data chunks + [DONE]')
    assert.ok(dataLines[dataLines.length - 1].includes('[DONE]'), 'last SSE line must be [DONE]')

    // Parse the first chunk
    const firstData = dataLines[0].slice(6) // strip "data: "
    const chunk = JSON.parse(firstData)

    // Chunk must have valid id
    assert.ok(chunk.id?.startsWith('chatcmpl-'), `chunk id must start with chatcmpl-, got ${chunk.id}`)

    // Chunk object must be chat.completion.chunk
    assert.equal(chunk.object, 'chat.completion.chunk', 'SSE chunk object must be chat.completion.chunk')

    // Chunk choices must have index, delta, finish_reason
    assert.ok(Array.isArray(chunk.choices), 'chunk must have choices array')
    assert.equal(chunk.choices[0].index, 0, 'chunk choice index must be 0')
    assert.ok(chunk.choices[0].delta, 'chunk choice must have delta')
    assert.equal(chunk.choices[0].delta.content, 'engram response', 'chunk delta content must be engram result')
    assert.equal(chunk.choices[0].finish_reason, 'stop', 'chunk finish_reason must be stop')
  })

  // ── Test 5: Failure mode ────────────────────────────────────────────

  it('(5a) engram::orchestrate failure falls back to direct provider gracefully', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainClassify: async () => ({ classification: 'COMPLEX', confidence: 0.75, source: 'heuristic' }),
      engramFails: true, // engram::orchestrate throws
      callProvider: async () => ({ id: 'r-fallback', content: 'fallback response from direct provider', finishReason: 'stop' }),
    })

    // Single message so when engram fails, the fallback goes through
    // the routeLlm path (not the multi-node DAG path)
    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Complex request that should trigger pipeline but engram will fail' },
      ],
    })

    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 200))

    // brain::classify was called
    const brainCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'brain::classify')
    assert.equal(brainCalls.length, 1, 'brain::classify must be called')

    // engram::orchestrate was attempted (and failed)
    const engramCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'engram::orchestrate')
    assert.equal(engramCalls.length, 1, 'engram::orchestrate must be attempted')

    // Response uses fallback to direct provider
    assert.equal(inv._statusCode(), 200, 'must return 200 even when engram fails')
    const response = parseResponse(inv._written)
    assertOpenAIFormat(response)
    assert.equal(response.choices[0].message.content, 'fallback response from direct provider',
      'must return direct provider fallback content when engram fails')
  })

  it('(5b) brain::classify failure does NOT trigger engram pipeline, uses direct provider', async () => {
    process.env.GATEWAY_USE_ENGRAM_PIPELINE = 'true'

    const iii = buildMockSdk({
      brainFails: true, // brain::classify throws
      callProvider: async () => ({ id: 'r-4', content: 'direct response', finishReason: 'stop' }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
    })

    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 200))

    // brain::classify was attempted
    const brainCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'brain::classify')
    assert.equal(brainCalls.length, 1, 'brain::classify was attempted')

    // engram::orchestrate was NOT called
    const engramCalls = iii._triggerCalls.filter((c: any) => c.function_id === 'engram::orchestrate')
    assert.equal(engramCalls.length, 0, 'engram::orchestrate must NOT be called when brain fails')

    // Falls through to direct provider successfully
    assert.equal(inv._statusCode(), 200)
    const response = parseResponse(inv._written)
    assertOpenAIFormat(response)
    assert.equal(response.choices[0].message.content, 'direct response')
  })

  // ── Test 6: Off-mode behavior ───────────────────────────────────────

  it('(6) Off-mode: GATEWAY_USE_ENGRAM_PIPELINE not set, direct provider used', async () => {
    // Deliberately not setting the env var

    const iii = buildMockSdk({
      callProvider: async () => ({ id: 'r-5', content: 'direct response', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }),
    })

    const inv = mockInvocation({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
    })

    const handler = createChatCompletionsHandler(iii, { callProvider: iii._callProvider })
    await handler(inv as any)
    await new Promise(r => setTimeout(r, 200))

    // Should return successfully via direct provider
    assert.equal(inv._statusCode(), 200)
    const response = parseResponse(inv._written)
    assert.equal(response.choices[0].message.content, 'direct response')

    // No GATEWAY_* telemetry events
    const telemetryCalls = iii._triggerCalls.filter(
      (c: any) => c.function_id === 'log_event',
    )
    const eventClasses = telemetryCalls.map((c: any) => (c.payload as any)?.eventClass)
    const gatewayEvents = eventClasses.filter((e: string) => e?.startsWith('GATEWAY_'))
    assert.equal(gatewayEvents.length, 0, 'no GATEWAY_* telemetry in off-mode')
  })
})
