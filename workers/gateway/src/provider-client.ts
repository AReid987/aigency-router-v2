/**
 * Provider Client — HTTP client for OpenAI-compatible provider APIs.
 *
 * All three providers (Groq, Cerebras, Together AI) share the same
 * request/response schema. Only base URL and auth header differ.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface ProviderConfig {
  baseUrl: string
  envKey: string
}

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamChunk {
  id: string
  delta: string
  finishReason: string | null
}

export interface ProviderResponse {
  id: string
  content: string
  finishReason: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

// ── Provider Registry ──────────────────────────────────────────────────

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    envKey: 'GROQ_API_KEY',
  },
  cerebras: {
    baseUrl: 'https://api.cerebras.ai/v1/chat/completions',
    envKey: 'CEREBRAS_API_KEY',
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1/chat/completions',
    envKey: 'TOGETHER_API_KEY',
  },
}

// ── Helpers ────────────────────────────────────────────────────────────

export function parseProviderModel(providerModel: string): { provider: string; model: string } {
  const slashIdx = providerModel.indexOf('/')
  if (slashIdx === -1) {
    return { provider: 'unknown', model: providerModel }
  }
  return {
    provider: providerModel.slice(0, slashIdx),
    model: providerModel.slice(slashIdx + 1),
  }
}

export function getProviderConfig(provider: string): ProviderConfig | undefined {
  return PROVIDER_CONFIGS[provider]
}

// ── Core Client ────────────────────────────────────────────────────────

export interface CallProviderOptions {
  stream?: boolean
  maxTokens?: number
  temperature?: number
  fetchFn?: typeof fetch   // injectable for testing
}

/**
 * Call an OpenAI-compatible provider API.
 *
 * For streaming requests, returns an async generator of StreamChunk.
 * For non-streaming, returns a ProviderResponse.
 */
export async function callProvider(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: Message[],
  options: CallProviderOptions = {},
): Promise<ProviderResponse | AsyncGenerator<StreamChunk>> {
  const { stream = false, maxTokens, temperature, fetchFn = fetch } = options

  const body: Record<string, unknown> = { model, messages, stream }
  if (maxTokens != null) body.max_tokens = maxTokens
  if (temperature != null) body.temperature = temperature

  const response = await fetchFn(config.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorBody = await safeReadBody(response)
    throw new ProviderError(response.status, errorBody, config.baseUrl)
  }

  if (stream) {
    return streamResponse(response)
  }

  return parseNonStreamingResponse(response)
}

// ── Error Handling ─────────────────────────────────────────────────────

export class ProviderError extends Error {
  readonly status: number
  readonly responseBody: string
  readonly url: string

  constructor(status: number, responseBody: string, url: string) {
    super(`Provider returned ${status}: ${responseBody}`)
    this.name = 'ProviderError'
    this.status = status
    this.responseBody = responseBody
    this.url = url
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return '<unreadable body>'
  }
}

// ── SSE Streaming Parser ──────────────────────────────────────────────

function processSSELine(line: string): StreamChunk | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':')) return null
  if (trimmed === 'data: [DONE]') return null

  if (trimmed.startsWith('data: ')) {
    const json = trimmed.slice(6)
    try {
      const parsed = JSON.parse(json)
      const delta = parsed.choices?.[0]?.delta
      if (delta?.content) {
        return {
          id: parsed.id ?? '',
          delta: delta.content,
          finishReason: parsed.choices[0]?.finish_reason ?? null,
        }
      }
    } catch {
      // skip malformed JSON lines
    }
  }
  return null
}

async function* streamResponse(response: Response): AsyncGenerator<StreamChunk> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false

  try {
    while (!done) {
      const readResult = await reader.read()
      done = readResult.done

      if (readResult.value) {
        buffer += decoder.decode(readResult.value, { stream: !done })
      }

      const lines = buffer.split('\n')
      // If not done, keep the last (potentially incomplete) line in buffer
      buffer = done ? '' : (lines.pop() ?? '')

      for (const line of lines) {
        const chunk = processSSELine(line)
        if (chunk) yield chunk
      }
    }

    // Flush remaining buffer after stream ends
    if (buffer.trim()) {
      const chunk = processSSELine(buffer)
      if (chunk) yield chunk
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Non-streaming Parser ──────────────────────────────────────────────

async function parseNonStreamingResponse(response: Response): Promise<ProviderResponse> {
  const data = await response.json() as Record<string, unknown>
  const choices = data.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0] as Record<string, unknown> | undefined
  const message = choice?.message as Record<string, unknown> | undefined

  return {
    id: (data.id as string) ?? '',
    content: (message?.content as string) ?? '',
    finishReason: (choice?.finish_reason as string) ?? 'stop',
    usage: data.usage as ProviderResponse['usage'],
  }
}
