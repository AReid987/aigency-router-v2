import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseProviderModel,
  getProviderConfig,
  callProvider,
  ProviderError,
  type Message,
  type ProviderConfig,
} from './provider-client.ts'

// ── parseProviderModel ─────────────────────────────────────────────────

describe('parseProviderModel', () => {
  it('splits "groq/llama3-8b-8192" into provider and model', () => {
    const result = parseProviderModel('groq/llama3-8b-8192')
    assert.deepEqual(result, { provider: 'groq', model: 'llama3-8b-8192' })
  })

  it('splits "cerebras/llama3.1-8b" correctly', () => {
    const result = parseProviderModel('cerebras/llama3.1-8b')
    assert.deepEqual(result, { provider: 'cerebras', model: 'llama3.1-8b' })
  })

  it('splits "together/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo" on first slash only', () => {
    const result = parseProviderModel('together/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')
    assert.deepEqual(result, {
      provider: 'together',
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    })
  })

  it('handles string with no slash as provider "unknown"', () => {
    const result = parseProviderModel('llama3')
    assert.deepEqual(result, { provider: 'unknown', model: 'llama3' })
  })

  it('handles empty string', () => {
    const result = parseProviderModel('')
    assert.deepEqual(result, { provider: 'unknown', model: '' })
  })
})

// ── getProviderConfig ──────────────────────────────────────────────────

describe('getProviderConfig', () => {
  it('returns correct URL for groq', () => {
    const config = getProviderConfig('groq')
    assert.ok(config)
    assert.equal(config.baseUrl, 'https://api.groq.com/openai/v1/chat/completions')
    assert.equal(config.envKey, 'GROQ_API_KEY')
  })

  it('returns correct URL for cerebras', () => {
    const config = getProviderConfig('cerebras')
    assert.ok(config)
    assert.equal(config.baseUrl, 'https://api.cerebras.ai/v1/chat/completions')
    assert.equal(config.envKey, 'CEREBRAS_API_KEY')
  })

  it('returns correct URL for together', () => {
    const config = getProviderConfig('together')
    assert.ok(config)
    assert.equal(config.baseUrl, 'https://api.together.xyz/v1/chat/completions')
    assert.equal(config.envKey, 'TOGETHER_API_KEY')
  })

  it('returns undefined for unknown provider', () => {
    const config = getProviderConfig('nonexistent')
    assert.equal(config, undefined)
  })
})

// ── callProvider — request construction ────────────────────────────────

describe('callProvider request construction', () => {
  const mockConfig: ProviderConfig = {
    baseUrl: 'https://api.example.com/v1/chat/completions',
    envKey: 'TEST_KEY',
  }
  const messages: Message[] = [{ role: 'user', content: 'hello' }]

  it('sends correct headers and body for non-streaming', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString()
      capturedInit = init
      return new Response(JSON.stringify({
        id: 'resp-1',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      }))
    }

    await callProvider(mockConfig, 'sk-test', 'gpt-4', messages, { fetchFn: mockFetch })

    assert.equal(capturedUrl, mockConfig.baseUrl)

    const headers = capturedInit!.headers as Record<string, string>
    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(headers['Authorization'], 'Bearer sk-test')

    const body = JSON.parse(capturedInit!.body as string)
    assert.equal(body.model, 'gpt-4')
    assert.deepEqual(body.messages, messages)
    assert.equal(body.stream, false)
  })

  it('includes maxTokens and temperature when provided', async () => {
    let capturedBody: Record<string, unknown> | undefined

    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string)
      return new Response(JSON.stringify({
        id: 'resp-2',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }))
    }

    await callProvider(mockConfig, 'sk-test', 'gpt-4', messages, {
      fetchFn: mockFetch,
      maxTokens: 1024,
      temperature: 0.7,
    })

    assert.equal(capturedBody!.max_tokens, 1024)
    assert.equal(capturedBody!.temperature, 0.7)
  })

  it('sets stream=true in body when streaming requested', async () => {
    let capturedBody: Record<string, unknown> | undefined

    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string)
      // Return a minimal SSE stream
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n'))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const result = await callProvider(mockConfig, 'sk-test', 'gpt-4', messages, {
      fetchFn: mockFetch,
      stream: true,
    })

    assert.equal(capturedBody!.stream, true)
    // result should be an async generator
    assert.ok(Symbol.asyncIterator in (result as AsyncGenerator))
  })
})

// ── callProvider — non-streaming response parsing ─────────────────────

describe('callProvider non-streaming response parsing', () => {
  const mockConfig: ProviderConfig = {
    baseUrl: 'https://api.example.com/v1/chat/completions',
    envKey: 'TEST_KEY',
  }
  const messages: Message[] = [{ role: 'user', content: 'hello' }]

  it('parses a standard non-streaming response', async () => {
    const mockFetch = async () => new Response(JSON.stringify({
      id: 'chatcmpl-123',
      choices: [{ message: { content: 'Hello world' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))

    const result = await callProvider(mockConfig, 'sk-test', 'gpt-4', messages, {
      fetchFn: mockFetch,
    }) as Awaited<ReturnType<typeof callProvider>>

    // Result is ProviderResponse (not generator)
    if (Symbol.asyncIterator in (result as object)) {
      assert.fail('Expected ProviderResponse, got generator')
    }

    const resp = result as { id: string; content: string; finishReason: string }
    assert.equal(resp.id, 'chatcmpl-123')
    assert.equal(resp.content, 'Hello world')
    assert.equal(resp.finishReason, 'stop')
  })
})

// ── callProvider — SSE streaming parsing ───────────────────────────────

describe('callProvider SSE streaming parsing', () => {
  const mockConfig: ProviderConfig = {
    baseUrl: 'https://api.example.com/v1/chat/completions',
    envKey: 'TEST_KEY',
  }
  const messages: Message[] = [{ role: 'user', content: 'hello' }]

  it('yields content deltas from SSE stream', async () => {
    const sseData = [
      'data: {"id":"s1","choices":[{"delta":{"content":"Hello"},"index":0}]}\n',
      'data: {"id":"s1","choices":[{"delta":{"content":" world"},"index":0}]}\n',
      'data: {"id":"s1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n',
      'data: [DONE]\n',
    ].join('')

    const mockFetch = async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const result = await callProvider(mockConfig, 'sk-test', 'gpt-4', messages, {
      fetchFn: mockFetch,
      stream: true,
    })

    assert.ok(Symbol.asyncIterator in (result as object))

    const chunks: string[] = []
    for await (const chunk of result as AsyncGenerator<{ delta: string }>) {
      chunks.push(chunk.delta)
    }

    assert.deepEqual(chunks, ['Hello', ' world'])
  })

  it('handles chunked SSE data split across reads', async () => {
    // Simulate data arriving in fragments
    const fragments = [
      'data: {"id":"s2","choices":[{"delta":{"content":"A"}}',
      ']}\ndata: {"id":"s2","choices":[{"delta":{"content":"B"}}]}\n',
      'data: [DONE]\n',
    ]

    const mockFetch = async () => {
      let i = 0
      const stream = new ReadableStream({
        pull(controller) {
          if (i < fragments.length) {
            controller.enqueue(new TextEncoder().encode(fragments[i]))
            i++
          } else {
            controller.close()
          }
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const result = await callProvider(mockConfig, 'sk-test', 'gpt-4', messages, {
      fetchFn: mockFetch,
      stream: true,
    })

    const chunks: string[] = []
    for await (const chunk of result as AsyncGenerator<{ delta: string }>) {
      chunks.push(chunk.delta)
    }

    assert.deepEqual(chunks, ['A', 'B'])
  })
})

describe('callProvider SSE comment/empty line handling', () => {
  const mockConfig: ProviderConfig = {
    baseUrl: 'https://api.example.com/v1/chat/completions',
    envKey: 'TEST_KEY',
  }
  const messages: Message[] = [{ role: 'user', content: 'hello' }]

  it('skips comment lines and empty lines in SSE stream', async () => {
    const sseData = [
      ': this is a comment\n',
      '\n',
      'data: {"id":"s3","choices":[{"delta":{"content":"OK"}}]}\n',
      'data: [DONE]\n',
    ].join('')

    const mockFetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const result = await callProvider(mockConfig, 'sk-test', 'gpt-4', messages, {
      fetchFn: mockFetch,
      stream: true,
    })

    const chunks: string[] = []
    for await (const chunk of result as AsyncGenerator<{ delta: string }>) {
      chunks.push(chunk.delta)
    }

    assert.deepEqual(chunks, ['OK'])
  })
})

// ── callProvider — error handling ──────────────────────────────────────

describe('callProvider error handling', () => {
  const mockConfig: ProviderConfig = {
    baseUrl: 'https://api.example.com/v1/chat/completions',
    envKey: 'TEST_KEY',
  }
  const messages: Message[] = [{ role: 'user', content: 'hello' }]

  it('throws ProviderError on 401 Unauthorized', async () => {
    const mockFetch = async () => new Response(
      JSON.stringify({ error: { message: 'Invalid API key' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )

    await assert.rejects(
      () => callProvider(mockConfig, 'bad-key', 'gpt-4', messages, { fetchFn: mockFetch }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.equal(err.status, 401)
        return true
      },
    )
  })

  it('throws ProviderError on 429 Rate Limited', async () => {
    const mockFetch = async () => new Response(
      JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )

    await assert.rejects(
      () => callProvider(mockConfig, 'sk-test', 'gpt-4', messages, { fetchFn: mockFetch }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.equal(err.status, 429)
        return true
      },
    )
  })

  it('throws ProviderError on 500 Internal Server Error', async () => {
    const mockFetch = async () => new Response(
      'Internal Server Error',
      { status: 500, headers: { 'Content-Type': 'text/plain' } },
    )

    await assert.rejects(
      () => callProvider(mockConfig, 'sk-test', 'gpt-4', messages, { fetchFn: mockFetch }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.equal(err.status, 500)
        assert.match(err.responseBody, /Internal Server Error/)
        return true
      },
    )
  })

  it('ProviderError includes the URL that failed', async () => {
    const mockFetch = async () => new Response('', { status: 502 })

    await assert.rejects(
      () => callProvider(mockConfig, 'sk-test', 'gpt-4', messages, { fetchFn: mockFetch }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.equal(err.url, mockConfig.baseUrl)
        return true
      },
    )
  })
})
