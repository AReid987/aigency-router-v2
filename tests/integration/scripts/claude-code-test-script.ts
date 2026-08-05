#!/usr/bin/env tsx
/**
 * claude-code-test-script.ts — Spawned script for Claude Code usage pattern E2E test.
 *
 * Exercises the AigencyClient SDK with realistic Claude Code usage patterns:
 *   1. Multi-turn conversation with streaming (4 turns)
 *   2. Tool definitions passed through to gateway
 *   3. SDK retry on 5xx responses
 *   4. AbortSignal cancellation mid-stream
 *
 * Environment:
 *   GATEWAY_URL — Base URL of the mock gateway (default http://127.0.0.1:18080/v1)
 *
 * Output: single JSON line { "passed": number, "failed": number, "details": string[] }
 * Exit 0 if all passed, 1 otherwise.
 */

import { AigencyClient } from '../../../workers/agents/sdk/ts/src/client.js'
import type { ChatCompletionChunk } from '../../../workers/agents/sdk/ts/src/types.js'

interface TestResults {
  passed: number
  failed: number
  details: string[]
}

function stdout(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj))
}

// ── Scenario 1: Multi-turn streaming conversation ————————————————

async function testMultiTurn(client: AigencyClient): Promise<void> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: 'You are a helpful AI assistant that answers questions concisely.' },
    { role: 'user', content: 'What is the capital of France?' },
  ]

  const turnQuestions = [
    'What is its most famous landmark?',
    'What river is it on?',
    'What is the population approximately?',
  ]

  for (let turn = 0; turn < 4; turn++) {
    const iterable = await client.chat.completions.create({
      model: 'test/multi-turn',
      messages: messages as any,
      stream: true,
    }, {}) as AsyncIterable<ChatCompletionChunk>

    let content = ''
    let chunkCount = 0
    for await (const chunk of iterable) {
      const delta = chunk.choices[0]?.delta?.content ?? ''
      content += delta
      if (delta.length > 0) chunkCount++
    }

    if (chunkCount === 0) throw new Error(`Turn ${turn + 1}: No streaming chunks received`)
    if (content.length === 0) throw new Error(`Turn ${turn + 1}: Empty response content`)

    // Append assistant response and next user message for context preservation
    messages.push({ role: 'assistant', content })
    if (turn < 3) {
      messages.push({ role: 'user', content: turnQuestions[turn] })
    }
  }

  // Verify all 4 turns produced content
  if (messages.length !== 9) {
    throw new Error(`Expected 9 messages (1 system + 4 user + 4 assistant), got ${messages.length}`)
  }
}

// ── Scenario 2: Tool definitions ————————————————————————————————

async function testToolDefs(client: AigencyClient): Promise<void> {
  const response = await client.chat.completions.create({
    model: 'test/tool-defs',
    messages: [
      { role: 'user', content: 'What is the weather in Paris?' },
    ],
    // Pass tool definitions — SDK serializes all extra properties to JSON
    tools: [
      {
        type: 'function',
        function: {
          name: 'getWeather',
          description: 'Get the current weather for a location',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' },
              unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
            },
            required: ['location'],
          },
        },
      },
    ] as any,
  } as any)

  if (!response || !response.id) throw new Error('No response received for tool defs request')
}

// ── Scenario 3: Retry on 5xx ————————————————————————————————

async function testRetry5xx(client: AigencyClient): Promise<void> {
  // SDK default maxRetries=3 handles the retry loop internally.
  // Mock server returns 500 twice then 200.
  const response = await client.chat.completions.create({
    model: 'test/retry-5xx',
    messages: [{ role: 'user', content: 'Trigger retry on server error' }],
  })

  if (!response || !response.id) throw new Error('No response received after retry')
}

// ── Scenario 4: AbortSignal cancellation ——————————————————————————

async function testAbort(client: AigencyClient): Promise<void> {
  const controller = new AbortController()

  const iterable = await client.chat.completions.create({
    model: 'test/abort-test',
    messages: [{ role: 'user', content: 'Stream and abort mid-response' }],
    stream: true,
  }, { signal: controller.signal }) as AsyncIterable<ChatCompletionChunk>

  // Abort mid-stream before reading all chunks
  controller.abort()

  let aborted = false
  try {
    for await (const _chunk of iterable) {
      // Some chunks may already be buffered — drain them
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      aborted = true
    } else {
      throw err
    }
  }

  if (!aborted) throw new Error('Stream was not aborted via AbortSignal')
}

// ── Main —————————————————————————————————————————————————————————

async function main(): Promise<void> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:18080/v1'
  const client = new AigencyClient(gatewayUrl, undefined, {
    maxRetries: 3,
    retryDelayMs: 10,
  })

  const results: TestResults = { passed: 0, failed: 0, details: [] }

  // Scenario 1
  try {
    await testMultiTurn(client)
    results.passed++
    results.details.push('PASS: Streaming multi-turn conversation (4 turns)')
  } catch (err: unknown) {
    results.failed++
    const msg = err instanceof Error ? err.message : String(err)
    results.details.push(`FAIL: Streaming multi-turn conversation — ${msg}`)
  }

  // Scenario 2
  try {
    await testToolDefs(client)
    results.passed++
    results.details.push('PASS: Tool definitions passed through to gateway')
  } catch (err: unknown) {
    results.failed++
    const msg = err instanceof Error ? err.message : String(err)
    results.details.push(`FAIL: Tool definitions — ${msg}`)
  }

  // Scenario 3
  try {
    await testRetry5xx(client)
    results.passed++
    results.details.push('PASS: SDK retry on 5xx')
  } catch (err: unknown) {
    results.failed++
    const msg = err instanceof Error ? err.message : String(err)
    results.details.push(`FAIL: SDK retry on 5xx — ${msg}`)
  }

  // Scenario 4
  try {
    await testAbort(client)
    results.passed++
    results.details.push('PASS: AbortSignal cancels mid-stream')
  } catch (err: unknown) {
    results.failed++
    const msg = err instanceof Error ? err.message : String(err)
    results.details.push(`FAIL: AbortSignal cancellation — ${msg}`)
  }

  stdout(results as unknown as Record<string, unknown>)
  process.exit(results.failed > 0 ? 1 : 0)
}

main().catch((err: Error) => {
  stdout({ passed: 0, failed: 1, details: [`UNCAUGHT: ${err.message}`] })
  process.exit(1)
})
