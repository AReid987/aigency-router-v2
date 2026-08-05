#!/usr/bin/env tsx
/**
 * sdk-cli-agent.ts — Spawned script for the CLI agent SDK E2E test.
 *
 * Uses the real AigencyClient SDK (from S01) to make requests to a
 * mock gateway server with zero-cost enforcement.
 *
 * Environment variables:
 *   GATEWAY_URL  — Base URL of the mock gateway (e.g. http://localhost:3456)
 *   MODE          — nonstream | stream | exhaust-nonstream | quota | paid-refused
 *   MODEL         — Model name to request (e.g. "groq/gpt-4")
 *   REQUEST_COUNT — Number of requests to make (for exhaust mode, default 5)
 *
 * Output: one JSON line per result, with a "type" discriminator.
 */

import { AigencyClient } from '../../../workers/agents/sdk/ts/src/client.js'
import { getQuotaStatus } from '../../../workers/agents/sdk/ts/src/monitoring.js'
import type { ChatCompletionResponse, ChatCompletionChunk } from '../../../workers/agents/sdk/ts/src/types.js'

function stdout(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj))
}

function stderr(msg: string): void {
  console.error(msg)
}

async function main(): Promise<void> {
  const gatewayUrl = process.env.GATEWAY_URL
  if (!gatewayUrl) {
    stdout({ type: 'error', message: 'GATEWAY_URL is required' })
    process.exit(1)
  }

  const mode = process.env.MODE ?? 'nonstream'
  const model = process.env.MODEL ?? 'groq/gpt-4'
  const requestCount = parseInt(process.env.REQUEST_COUNT ?? '5', 10)

  const client = new AigencyClient(gatewayUrl, undefined, {
    maxRetries: 0, // no retries — fail fast for testing
    retryDelayMs: 10,
  })

  try {
    switch (mode) {
      case 'nonstream':
        await doNonStream(client, model)
        break
      case 'stream':
        await doStream(client, model)
        break
      case 'exhaust-nonstream':
        await doExhaustNonStream(client, model, requestCount)
        break
      case 'quota':
        await doQuota(gatewayUrl)
        break
      case 'paid-refused':
        await doPaidRefused(client, model)
        break
      default:
        stdout({ type: 'error', message: `Unknown mode: ${mode}` })
        process.exit(1)
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    stdout({ type: 'error', message: msg, stack: err instanceof Error ? err.stack : undefined })
    process.exit(1)
  }
}

async function doNonStream(client: AigencyClient, model: string): Promise<void> {
  stdout({ type: 'action', action: 'nonstream', model })

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Hello, what is 2+2?' }],
  }) as ChatCompletionResponse

  stdout({
    type: 'nonstream_result',
    id: response.id,
    object: response.object,
    model: response.model,
    content: response.choices[0]?.message?.content ?? '',
    finish_reason: response.choices[0]?.finish_reason ?? '',
    has_usage: !!response.usage,
    usage: response.usage ?? null,
  })
}

async function doStream(client: AigencyClient, model: string): Promise<void> {
  stdout({ type: 'action', action: 'stream', model })

  const iterable = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
    stream: true,
  }) as AsyncIterable<ChatCompletionChunk>

  const chunks: ChatCompletionChunk[] = []
  for await (const chunk of iterable) {
    chunks.push(chunk)
  }

  const fullContent = chunks.map(c => c.choices[0]?.delta?.content ?? '').join('')

  stdout({
    type: 'stream_result',
    chunk_count: chunks.length,
    full_content: fullContent,
    first_chunk_id: chunks[0]?.id ?? null,
    last_finish_reason: chunks[chunks.length - 1]?.choices[0]?.finish_reason ?? null,
  })
}

async function doExhaustNonStream(client: AigencyClient, model: string, count: number): Promise<void> {
  stdout({ type: 'action', action: 'exhaust-nonstream', model, count })

  const results: Array<{ request: number; success: boolean; provider?: string; content?: string; error?: string }> = []

  for (let i = 0; i < count; i++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: `Request number ${i + 1}` }],
      }) as ChatCompletionResponse

      results.push({
        request: i + 1,
        success: true,
        content: response.choices[0]?.message?.content ?? '',
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        request: i + 1,
        success: false,
        error: msg,
      })
    }
  }

  stdout({ type: 'exhaust_result', results })
}

async function doQuota(gatewayUrl: string): Promise<void> {
  stdout({ type: 'action', action: 'quota' })

  const status = await getQuotaStatus(gatewayUrl)

  stdout({
    type: 'quota_status',
    providers: status.providers.map(p => ({
      name: p.name,
      current: p.current,
      limit: p.limit,
      utilization_pct: p.utilization_pct,
    })),
  })
}

async function doPaidRefused(client: AigencyClient, model: string): Promise<void> {
  stdout({ type: 'action', action: 'paid-refused', model })

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
    }) as ChatCompletionResponse

    // If we get here, the request was NOT refused — that's a failure
    stdout({
      type: 'paid_refused_unexpected_success',
      content: response.choices[0]?.message?.content ?? '',
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    stdout({ type: 'paid_refused', error: msg })
  }
}

main()
