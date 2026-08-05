/**
 * Integration tests for @aigency/sdk.
 *
 * Uses `node:test` + `node:assert/strict` — no external dependencies.
 * Mocks global fetch to test all SDK features without a live server.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AigencyClient, AigencyHttpError } from './client.js'
import { getQuotaStatus } from './monitoring.js'
import type { ChatCompletionResponse, ChatCompletionChunk, QuotaStatus } from './types.js'

// ── Helpers ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface MockFetchCall {
  url: string
  init: RequestInit
}

/**
 * Create a mock fetch implementation that returns the given response
 * for any request. Tracks calls for assertion.
 */
function mockFetchWithResponse(response: Response): { fetch: typeof globalThis.fetch; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = []
  const fetch: typeof globalThis.fetch = (url, init) => {
    calls.push({ url: url.toString(), init: init ?? {} })
    return Promise.resolve(response.clone())
  }
  return { fetch, calls }
}

/**
 * Create a mock fetch implementation with a response factory
 * that gets called each time, allowing for dynamic responses.
 */
function mockFetchWithFactory(
  factory: (url: string, init: RequestInit, callIndex: number) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = []
  let callIndex = 0
  const fetch: typeof globalThis.fetch = (url, init) => {
    const call = { url: url.toString(), init: init ?? {} }
    calls.push(call)
    return Promise.resolve(factory(url.toString(), init ?? {}, callIndex++))
  }
  return { fetch, calls }
}

/**
 * Build a fake Response object (subset of the Web API Response).
 */
function fakeResponse(body: string, status: number = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

/**
 * Build a fake Response with a ReadableStream body for SSE streaming.
 */
function fakeStreamResponse(chunks: string[], status: number = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  })
}

// ── Sample Data ────────────────────────────────────────────────────────

const sampleNonStreamResponse: ChatCompletionResponse = {
  id: 'chatcmpl-test123',
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'gpt-4',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello! How can I help you today?' },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 8,
    total_tokens: 18,
  },
}

const sampleChunk1: ChatCompletionChunk = {
  id: 'chatcmpl-chunk123',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'gpt-4',
  choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
}

const sampleChunk2: ChatCompletionChunk = {
  id: 'chatcmpl-chunk123',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'gpt-4',
  choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'stop' }],
}

const sampleQuotaStatus: QuotaStatus = {
  providers: [
    { name: 'groq', current: 100, limit: 1000, utilization_pct: 10, projected_exhaustion_at: Date.now() + 3600000 },
    { name: 'together', current: 50, limit: 500, utilization_pct: 10, projected_exhaustion_at: null },
  ],
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('AigencyClient', () => {
  let savedFetch: typeof globalThis.fetch | undefined

  // Save and restore global fetch
  beforeEach(() => {
    savedFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = savedFetch!
  })

  // ── Test (i): Non-streaming request ────────────────────────────────

  it('(i) Non-streaming request returns parsed ChatCompletionResponse', async () => {
    const body = JSON.stringify(sampleNonStreamResponse)
    const { fetch, calls } = mockFetchWithResponse(fakeResponse(body))
    globalThis.fetch = fetch

    const client = new AigencyClient('http://localhost:8787', 'sk-test', { fetch })
    const result = await client.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello!' }],
    }) as ChatCompletionResponse

    // Verify result
    assert.equal(result.id, 'chatcmpl-test123')
    assert.equal(result.object, 'chat.completion')
    assert.equal(result.choices.length, 1)
    assert.equal(result.choices[0].message.content, 'Hello! How can I help you today?')
    assert.equal(result.usage?.total_tokens, 18)

    // Verify the request
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.endsWith('/v1/chat/completions'))
    assert.equal((calls[0].init as RequestInit).method, 'POST')

    const requestBody = JSON.parse((calls[0].init as RequestInit).body as string)
    assert.equal(requestBody.model, 'gpt-4')
    assert.equal(requestBody.messages[0].content, 'Hello!')
    assert.equal(requestBody.stream, undefined) // not set
  })

  // ── Test (ii): Streaming request ───────────────────────────────────

  it('(ii) Streaming request yields ChatCompletionChunk objects via AsyncIterable', async () => {
    const sseChunks = [
      `data: ${JSON.stringify(sampleChunk1)}\n\n`,
      `data: ${JSON.stringify(sampleChunk2)}\n\n`,
      'data: [DONE]\n\n',
    ]

    const { fetch, calls } = mockFetchWithResponse(fakeStreamResponse(sseChunks))
    globalThis.fetch = fetch

    const client = new AigencyClient('http://localhost:8787', 'sk-test', { fetch })
    const result = await client.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      stream: true,
    })

    // Verify it's an async iterable
    assert.ok(result !== undefined)
    assert.ok(typeof (result as AsyncIterable<ChatCompletionChunk>)[Symbol.asyncIterator] === 'function')

    const chunks: ChatCompletionChunk[] = []
    for await (const chunk of result as AsyncIterable<ChatCompletionChunk>) {
      chunks.push(chunk)
    }

    // Verify chunks
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0].choices[0].delta.content, 'Hello')
    assert.equal(chunks[1].choices[0].delta.content, '!')
    assert.equal(chunks[1].choices[0].finish_reason, 'stop')

    // Verify the request was made
    assert.equal(calls.length, 1)
    const requestBody = JSON.parse((calls[0].init as RequestInit).body as string)
    assert.equal(requestBody.stream, true)
  })

  // ── Test (iii): Retry on 5xx ───────────────────────────────────────

  it('(iii) Retries on 5xx and returns success after retries', async () => {
    const attemptResponses = [
      fakeResponse('{"error":"upstream error"}', 502),
      fakeResponse('{"error":"still failing"}', 503),
      fakeResponse(JSON.stringify(sampleNonStreamResponse), 200),
    ]

    let attemptIndex = 0
    const { fetch, calls } = mockFetchWithFactory((url, init) => {
      return attemptResponses[attemptIndex++]
    })
    globalThis.fetch = fetch

    const client = new AigencyClient('http://localhost:8787', 'sk-test', {
      fetch,
      maxRetries: 3,
      retryDelayMs: 10, // fast retries for tests
    })

    const result = await client.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello!' }],
    }) as ChatCompletionResponse

    // Verify we got the successful response
    assert.equal(result.id, 'chatcmpl-test123')
    assert.equal(result.choices[0].message.content, 'Hello! How can I help you today?')

    // Verify 3 attempts were made (2 failures + 1 success)
    assert.equal(calls.length, 3, 'Should have made 3 attempts')
  })

  it('(iii-b) Throws after exhausting retries on persistent 5xx', async () => {
    const { fetch } = mockFetchWithFactory(() => {
      return fakeResponse('{"error":"always 502"}', 502)
    })
    globalThis.fetch = fetch

    const client = new AigencyClient('http://localhost:8787', 'sk-test', {
      fetch,
      maxRetries: 2,
      retryDelayMs: 10,
    })

    await assert.rejects(
      async () => {
        await client.chat.completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello!' }],
        })
      },
      (err: unknown) => {
        assert.ok(err instanceof AigencyHttpError, 'Should throw AigencyHttpError')
        assert.equal((err as AigencyHttpError).status, 502)
        return true
      },
    )
  })

  // ── Test (iv): Abort signal ────────────────────────────────────────

  it('(iv) AbortSignal cancels an in-flight request', async () => {
    // Create a fetch that stays pending but listens for abort signal
    const { fetch } = mockFetchWithFactory((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal | undefined
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'))
            return
          }
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        }
        // Otherwise never resolves
      })
    })
    globalThis.fetch = fetch

    const client = new AigencyClient('http://localhost:8787', 'sk-test', {
      fetch,
      maxRetries: 0, // no retries — fail fast on abort
    })

    const controller = new AbortController()

    // Schedule abort after a short delay
    setTimeout(() => controller.abort(), 20)

    await assert.rejects(
      async () => {
        await client.chat.completions.create(
          {
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hello!' }],
          },
          { signal: controller.signal },
        )
      },
      (err: unknown) => {
        assert.ok(err instanceof DOMException, 'Should throw DOMException AbortError')
        assert.equal((err as DOMException).name, 'AbortError')
        return true
      },
    )
  })

  // ── Test (v): getQuotaStatus ───────────────────────────────────────

  it('(v) getQuotaStatus fetches and parses quota data', async () => {
    const body = JSON.stringify(sampleQuotaStatus)
    const { fetch, calls } = mockFetchWithResponse(fakeResponse(body))
    globalThis.fetch = fetch

    const result = await getQuotaStatus('http://localhost:8787', 'sk-test')

    // Verify parsed result
    assert.equal(result.providers.length, 2)
    assert.equal(result.providers[0].name, 'groq')
    assert.equal(result.providers[0].current, 100)
    assert.equal(result.providers[0].limit, 1000)
    assert.equal(result.providers[0].utilization_pct, 10)
    assert.ok(typeof result.providers[0].projected_exhaustion_at === 'number')

    assert.equal(result.providers[1].name, 'together')
    assert.equal(result.providers[1].projected_exhaustion_at, null)

    // Verify the request URL
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.endsWith('/v1/admin/quota'))
    assert.ok(calls[0].init.headers !== undefined)
    assert.ok(
      ((calls[0].init as RequestInit).headers as Record<string, string>)['authorization']?.includes('Bearer sk-test'),
    )
  })

  it('(v-b) getQuotaStatus works without apiKey', async () => {
    const body = JSON.stringify(sampleQuotaStatus)
    const { fetch, calls } = mockFetchWithResponse(fakeResponse(body))
    globalThis.fetch = fetch

    const result = await getQuotaStatus('http://localhost:8787')

    assert.equal(result.providers.length, 2)
    assert.equal(calls.length, 1)

    // Should not have authorization header
    const headers = (calls[0].init as RequestInit).headers as Record<string, string>
    assert.equal(headers['authorization'], undefined)
  })

  // ── Test (vi): Claude Code example config ──────────────────────────

  it('(vi) Claude Code example config parses with expected structure', async () => {
    const configPath = join(__dirname, '..', 'examples', 'claude-code', 'config.example.json')
    const content = await readFile(configPath, 'utf-8')
    const config = JSON.parse(content)

    // Verify structure
    assert.ok(config, 'config must parse as JSON')
    assert.ok(config.comment, 'config must have a comment field')
    assert.ok(config.env, 'config must have env object')
    assert.ok(config.env.AIGENCY_BASE_URL, 'config.env must have AIGENCY_BASE_URL')
    assert.ok(config.env.AIGENCY_API_KEY, 'config.env must have AIGENCY_API_KEY')
    assert.ok(config.claude_code_config, 'config must have claude_code_config')
    assert.ok(config.claude_code_config.api_base_url, 'config.claude_code_config must have api_base_url')
    assert.ok(config.claude_code_config.api_key, 'config.claude_code_config must have api_key')
    assert.ok(config.claude_code_config.model, 'config.claude_code_config must have model')
    assert.ok(typeof config.claude_code_config.max_retries === 'number', 'max_retries must be a number')

    // Verify default values
    assert.equal(config.env.AIGENCY_BASE_URL, 'http://localhost:8787')
    assert.equal(config.claude_code_config.model, 'gpt-4')
    assert.equal(config.claude_code_config.max_retries, 3)
  })

  // ── Extra edge cases ───────────────────────────────────────────────

  it('Handles baseURL with trailing slash', async () => {
    const body = JSON.stringify(sampleNonStreamResponse)
    const { fetch, calls } = mockFetchWithResponse(fakeResponse(body))
    globalThis.fetch = fetch

    const client = new AigencyClient('http://localhost:8787/', 'sk-test', { fetch })
    await client.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }],
    }) as ChatCompletionResponse

    // URL should not have double slash
    assert.ok(!calls[0].url.includes('//v1'))
  })

  it('Works without apiKey', async () => {
    const body = JSON.stringify(sampleNonStreamResponse)
    const { fetch, calls } = mockFetchWithResponse(fakeResponse(body))
    globalThis.fetch = fetch

    const client = new AigencyClient('http://localhost:8787', undefined, { fetch })
    await client.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }],
    }) as ChatCompletionResponse

    const headers = (calls[0].init as RequestInit).headers as Record<string, string>
    assert.equal(headers['authorization'], undefined)
  })
})
