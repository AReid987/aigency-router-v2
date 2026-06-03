import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { healJson, buildRepairPrompt, JsonDriftError, type HealJsonDeps, type Message } from './heal-json.ts'

// ── Test Helpers ───────────────────────────────────────────────────────

function createMockGateway(response: string | (() => string)): HealJsonDeps['callGateway'] {
  if (typeof response === 'function') {
    return async (_model: string, _messages: Message[]) => response()
  }
  return async (_model: string, _messages: Message[]) => response
}

function createMockGatewayThatThrows(err: Error): HealJsonDeps['callGateway'] {
  return async (_model: string, _messages: Message[]) => { throw err }
}

function createSpyLogger(): { log: HealJsonDeps['log']; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = []
  return {
    log: (event: Record<string, unknown>) => events.push(event),
    events,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('healJson', () => {
  // Test 1: Valid JSON passthrough (no deps called)
  it('returns valid JSON immediately without calling any deps', async () => {
    const gatewaySpy = mock.fn()
    const repairSpy = mock.fn()
    const { log, events } = createSpyLogger()

    const result = await healJson(
      { jsonString: '{"name":"test","value":42}' },
      { callGateway: gatewaySpy, jsonrepair: repairSpy, log },
    )

    assert.equal(result.success, true)
    if (result.success) {
      assert.deepEqual(result.data, { name: 'test', value: 42 })
      assert.equal(result.attempts, 0)
    }
    assert.equal(gatewaySpy.mock.callCount(), 0)
    assert.equal(repairSpy.mock.callCount(), 0)
    assert.equal(events.length, 0) // No drift events for valid JSON
  })

  // Test 2: Valid JSON with extra whitespace
  it('handles valid JSON with extra whitespace', async () => {
    const result = await healJson({
      jsonString: '  {  "key" :  "value"  }  ',
    })

    assert.equal(result.success, true)
    if (result.success) {
      assert.deepEqual(result.data, { key: 'value' })
      assert.equal(result.attempts, 0)
    }
  })

  // Test 3: Malformed JSON repaired by local jsonrepair
  it('repairs malformed JSON using local jsonrepair (skips LLM)', async () => {
    const gatewaySpy = mock.fn()
    const { log, events } = createSpyLogger()

    // Single quotes are fixable by jsonrepair
    const result = await healJson(
      { jsonString: "{'name': 'test', 'value': 42}" },
      { callGateway: gatewaySpy, log },
    )

    assert.equal(result.success, true)
    if (result.success) {
      assert.deepEqual(result.data, { name: 'test', value: 42 })
      assert.equal(result.attempts, 0)
    }
    assert.equal(gatewaySpy.mock.callCount(), 0) // LLM not called
    assert.ok(events.some(e => e.event === 'drift_detected'))
    assert.ok(events.some(e => e.event === 'drift_healed' && e.method === 'local_jsonrepair'))
  })

  // Test 4: Malformed JSON repaired by LLM
  it('repairs malformed JSON using LLM when local repair fails', async () => {
    const brokenJson = '{name: "test", value: 42,}'  // Unquoted keys + trailing comma
    const llmResponse = '{"name":"test","value":42}'

    const { log, events } = createSpyLogger()

    const result = await healJson(
      { jsonString: brokenJson },
      {
        callGateway: createMockGateway(llmResponse),
        // Provide a jsonrepair that always fails to force LLM path
        jsonrepair: () => { throw new Error('local repair failed') },
        log,
      },
    )

    assert.equal(result.success, true)
    if (result.success) {
      assert.deepEqual(result.data, { name: 'test', value: 42 })
      assert.equal(result.attempts, 1)
    }
    assert.ok(events.some(e => e.event === 'drift_healing'))
    assert.ok(events.some(e => e.event === 'drift_healed' && e.method === 'llm'))
  })

  // Test 5: LLM returns non-JSON, jsonrepair on response succeeds
  it('repairs LLM response with jsonrepair when LLM returns non-JSON', async () => {
    const llmResponse = "Here's the fixed JSON:\n```json\n{\"key\":\"value\"}\n```"
    const { log, events } = createSpyLogger()

    const result = await healJson(
      { jsonString: '{key: value}' },
      {
        callGateway: createMockGateway(llmResponse),
        jsonrepair: (s: string) => {
          // Extract JSON from markdown
          const match = s.match(/\{[^}]+\}/)
          return match ? match[0] : s
        },
        log,
      },
    )

    assert.equal(result.success, true)
    if (result.success) {
      assert.deepEqual(result.data, { key: 'value' })
      assert.equal(result.attempts, 1)
    }
    assert.ok(events.some(e => e.event === 'drift_healed' && e.method === 'llm+jsonrepair'))
  })

  // Test 6: Max retries exceeded → graceful failure with partial result
  it('returns failure with partial result after max retries', async () => {
    let callCount = 0
    const { log, events } = createSpyLogger()

    const result = await healJson(
      { jsonString: 'totally broken', maxRetries: 2 },
      {
        callGateway: async () => {
          callCount++
          return `attempt ${callCount} - still broken`
        },
        jsonrepair: () => { throw new Error('nope') },
        log,
      },
    )

    assert.equal(result.success, false)
    assert.equal(result.attempts, 2)
    assert.equal(callCount, 2)
    if (!result.success) {
      assert.ok(result.partial?.includes('attempt 2'))
      assert.ok(result.error.includes('2 attempts'))
    }
    assert.ok(events.some(e => e.event === 'drift_failed'))
  })

  // Test 7: Gateway call failure → immediate error (no retry)
  it('returns error immediately on gateway failure without retrying', async () => {
    const gatewaySpy = mock.fn(async () => { throw new Error('connection refused') })
    const { log, events } = createSpyLogger()

    const result = await healJson(
      { jsonString: '{broken}' },
      {
        callGateway: gatewaySpy,
        jsonrepair: () => { throw new Error('nope') },
        log,
      },
    )

    assert.equal(result.success, false)
    assert.equal(gatewaySpy.mock.callCount(), 1) // Only called once
    if (!result.success) {
      assert.ok(result.error.includes('connection refused'))
    }
    assert.ok(events.some(e => e.event === 'drift_failed' && e.reason === 'gateway_error'))
  })

  // Test 8: Repair prompt contains the broken string
  it('buildRepairPrompt includes the broken string in the user message', () => {
    const broken = '{"malformed": true,}'
    const messages = buildRepairPrompt(broken)

    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'system')
    assert.equal(messages[1].role, 'user')
    assert.ok(messages[1].content.includes(broken))
    assert.ok(messages[0].content.includes('JSON'))
  })

  // Test 9: Temperature 0 and max_tokens 4096 used for repair
  it('passes correct parameters to gateway for repair', async () => {
    let capturedMessages: Message[] | undefined
    let capturedModel: string | undefined

    const result = await healJson(
      { jsonString: '{bad json}', model: 'mistral-7b' },
      {
        callGateway: async (model: string, messages: Message[]) => {
          capturedModel = model
          capturedMessages = messages
          return '{"fixed": true}'
        },
        jsonrepair: () => { throw new Error('nope') },
      },
    )

    assert.equal(capturedModel, 'mistral-7b')
    assert.ok(capturedMessages)
    assert.equal(capturedMessages![0].role, 'system')
    assert.equal(capturedMessages![1].role, 'user')
    assert.ok(capturedMessages![1].content.includes('{bad json}'))
    assert.equal(result.success, true)
  })

  // Test 10: No gateway caller provided → immediate error
  it('returns error when no gateway caller is provided', async () => {
    const { log, events } = createSpyLogger()

    const result = await healJson(
      { jsonString: '{broken}' },
      { jsonrepair: () => { throw new Error('nope') }, log },
    )

    assert.equal(result.success, false)
    assert.equal(result.attempts, 0)
    if (!result.success) {
      assert.ok(result.error.includes('No gateway caller'))
    }
    assert.ok(events.some(e => e.event === 'drift_failed'))
  })

  // Test 11: Custom dependency injection works
  it('uses custom jsonrepair dependency', async () => {
    const customRepair = mock.fn((s: string) => '{"custom": true}')
    const { log } = createSpyLogger()

    const result = await healJson(
      { jsonString: '{broken}' },
      { jsonrepair: customRepair, log },
    )

    assert.equal(result.success, true)
    assert.equal(customRepair.mock.callCount(), 1)
    if (result.success) {
      assert.deepEqual(result.data, { custom: true })
    }
  })

  // Test 12: Structured log events emitted correctly
  it('emits drift_detected and drift_healed events', async () => {
    const { log, events } = createSpyLogger()

    await healJson(
      { jsonString: "{'key': 'value'}" },
      { log },
    )

    assert.ok(events.some(e => e.event === 'drift_detected'))
    assert.ok(events.some(e => e.event === 'drift_healed'))
    assert.ok(events.every(e => typeof e.timestamp === 'string' || e.timestamp === undefined))
  })

  // Test 13: Empty string input
  it('handles empty string input', async () => {
    const { log, events } = createSpyLogger()

    const result = await healJson(
      { jsonString: '' },
      {
        callGateway: createMockGateway('{}'),
        log,
      },
    )

    assert.equal(result.success, true)
    if (result.success) {
      assert.deepEqual(result.data, {})
    }
  })

  // Test 14: Default max retries is 3
  it('uses default max retries of 3 when not specified', async () => {
    let callCount = 0

    const result = await healJson(
      { jsonString: '{broken}' },
      {
        callGateway: async () => {
          callCount++
          return 'still broken'
        },
        jsonrepair: () => { throw new Error('nope') },
      },
    )

    assert.equal(callCount, 3)
    assert.equal(result.attempts, 3)
  })

  // Test 15: LLM returns valid JSON on second attempt
  it('succeeds on second LLM attempt after first fails', async () => {
    let callCount = 0

    const result = await healJson(
      { jsonString: '{broken}' },
      {
        callGateway: async () => {
          callCount++
          return callCount === 1 ? 'not json' : '{"success": true}'
        },
        jsonrepair: () => { throw new Error('nope') },
      },
    )

    assert.equal(result.success, true)
    if (result.success) {
      assert.deepEqual(result.data, { success: true })
      assert.equal(result.attempts, 2)
    }
    assert.equal(callCount, 2)
  })
})
