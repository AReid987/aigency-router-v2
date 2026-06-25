/**
 * AigencyClient — OpenAI-compatible client with auto-retry on 5xx,
 * SSE streaming, and AbortSignal support.
 *
 * Uses the injected `fetch` (default globalThis.fetch) for testability.
 * No external dependencies — works with Node.js 18+, Deno, Bun, and browsers.
 */

import type {
  ChatCompletionRequestParam,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Model,
} from './types.js'

// ── Options ────────────────────────────────────────────────────────────

export interface AigencyClientOptions {
  /** Maximum number of retries on 5xx responses (default: 3) */
  maxRetries?: number
  /** Base delay for exponential backoff in ms (default: 100) */
  retryDelayMs?: number
  /** Custom fetch implementation for testing or environments without global fetch */
  fetch?: typeof globalThis.fetch
}

interface InternalOptions extends Required<AigencyClientOptions> {}

function resolveOptions(opts?: AigencyClientOptions): InternalOptions {
  return {
    maxRetries: opts?.maxRetries ?? 3,
    retryDelayMs: opts?.retryDelayMs ?? 100,
    fetch: opts?.fetch ?? globalThis.fetch,
  }
}

// ── SSE Parser ─────────────────────────────────────────────────────────

async function* parseSSE<T>(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<T> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Response body is not readable')

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') return
            yield JSON.parse(data) as T
          }
        }
      }

      // Process remaining buffer
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6)
        if (data !== '[DONE]') {
          yield JSON.parse(data) as T
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

// ── Retry Helper ───────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: InternalOptions,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    try {
      const response = await options.fetch(url, { ...init, signal })

      // Success — return immediately
      if (response.status < 500) return response

      // 5xx — retry unless it's the last attempt
      if (attempt < options.maxRetries) {
        const delay = options.retryDelayMs * Math.pow(2, attempt)
        await sleep(delay, signal)
        continue
      }

      // Last attempt — throw with status
      throw new AigencyHttpError(
        `Upstream error: ${response.status} ${response.statusText}`,
        response.status,
      )
    } catch (err) {
      // If it's already an AigencyHttpError, re-throw
      if (err instanceof AigencyHttpError) throw err

      // If it was aborted, re-throw
      if (err instanceof DOMException && err.name === 'AbortError') throw err

      lastError = err instanceof Error ? err : new Error(String(err))

      // Don't retry on non-5xx errors (network errors, 4xx, etc.)
      if (!(err instanceof TypeError) && !(err instanceof AigencyHttpError)) {
        // network errors (TypeError) should be retried
        if (!(err instanceof TypeError)) throw err
      }

      if (attempt < options.maxRetries) {
        const delay = options.retryDelayMs * Math.pow(2, attempt)
        await sleep(delay, signal)
      }
    }
  }

  throw lastError ?? new Error('Request failed after retries')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ── Custom Error ───────────────────────────────────────────────────────

export class AigencyHttpError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'AigencyHttpError'
    this.status = status
  }
}

// ── Chat Completions Sub ───────────────────────────────────────────────

class ChatCompletionsSub {
  private baseURL: string
  private apiKey: string | undefined
  private options: InternalOptions

  constructor(baseURL: string, apiKey: string | undefined, options: InternalOptions) {
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.apiKey = apiKey
    this.options = options
  }

  async create(
    params: ChatCompletionRequestParam,
    extra?: { signal?: AbortSignal },
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>> {
    const url = `${this.baseURL}/v1/chat/completions`
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      },
      this.options,
      extra?.signal,
    )

    if (params.stream) {
      return parseSSE<ChatCompletionChunk>(response, extra?.signal)
    }

    return (await response.json()) as ChatCompletionResponse
  }
}

// ── Models Namespace ───────────────────────────────────────────────────

class Models {
  private baseURL: string
  private apiKey: string | undefined
  private options: InternalOptions

  constructor(baseURL: string, apiKey: string | undefined, options: InternalOptions) {
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.apiKey = apiKey
    this.options = options
  }

  async list(signal?: AbortSignal): Promise<Model[]> {
    const url = `${this.baseURL}/v1/models`
    const headers: Record<string, string> = {}
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`

    const response = await this.options.fetch(url, { headers, signal })
    if (!response.ok) {
      throw new AigencyHttpError(
        `Failed to list models: ${response.status} ${response.statusText}`,
        response.status,
      )
    }
    const data = (await response.json()) as { data: Model[] }
    return data.data
  }
}

// ── Chat Namespace ────────────────────────────────────────────────────

class ChatNamespace {
  public completions: ChatCompletionsSub

  constructor(baseURL: string, apiKey: string | undefined, options: InternalOptions) {
    this.completions = new ChatCompletionsSub(baseURL, apiKey, options)
  }
}

// ── Main Client ────────────────────────────────────────────────────────

export class AigencyClient {
  public chat: ChatNamespace
  public models: Models
  private options: InternalOptions

  constructor(
    baseURL: string,
    apiKey?: string,
    opts?: AigencyClientOptions,
  ) {
    this.options = resolveOptions(opts)
    this.chat = new ChatNamespace(baseURL, apiKey, this.options)
    this.models = new Models(baseURL, apiKey, this.options)
  }
}
