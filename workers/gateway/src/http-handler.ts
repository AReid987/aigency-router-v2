/**
 * HTTP Handler — OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Accepts POST requests with OpenAI-compatible body, routes through
 * brain classification → translator resolution → vault key retrieval →
 * provider API call, and returns SSE streaming or JSON responses.
 */

import type { HttpRequest, HttpResponse, ISdk } from 'iii-sdk'
import { http } from 'iii-sdk'
import { routeLlm, type RouteLlmInput, type RouteLlmDeps, type StreamingRouteResult } from './index.ts'
import type { RouteResult } from './failover.ts'

// ── Types ──────────────────────────────────────────────────────────────

interface ChatCompletionsRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  stream?: boolean
  max_tokens?: number
  temperature?: number
}

interface OpenAIErrorResponse {
  error: {
    message: string
    type: string
    code?: string
  }
}

interface OpenAICompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: string; content: string }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ── Structured Logging ─────────────────────────────────────────────────

function logEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ...event, timestamp: new Date().toISOString() }))
}

// ── Helpers ────────────────────────────────────────────────────────────

function generateRequestId(): string {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function writeErrorResponse(res: HttpResponse, status: number, message: string, type: string = 'invalid_request_error'): void {
  res.status(status)
  res.headers({ 'content-type': 'application/json' })
  const errorBody: OpenAIErrorResponse = { error: { message, type } }
  res.stream.end(JSON.stringify(errorBody))
  res.close()
}

function writeJSONResponse(res: HttpResponse, body: OpenAICompletionResponse): void {
  res.status(200)
  res.headers({ 'content-type': 'application/json' })
  res.stream.end(JSON.stringify(body))
  res.close()
}

// ── HTTP Handler ───────────────────────────────────────────────────────

export function createChatCompletionsHandler(iii: ISdk, overrides?: { callProvider?: (...args: any[]) => Promise<any> }) {
  return http(async (req: HttpRequest, res: HttpResponse) => {
    const body = req.body as ChatCompletionsRequest | undefined

    logEvent({
      event: 'chat_completions_request',
      model: body?.model,
      stream: body?.stream ?? false,
      messageCount: body?.messages?.length ?? 0,
    })

    // ── Input Validation ────────────────────────────────────────────
    if (!body?.model) {
      writeErrorResponse(res, 400, "Missing required field: 'model'")
      return
    }
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      writeErrorResponse(res, 400, "Missing required field: 'messages' (non-empty array)")
      return
    }

    // ── Fire-and-forget brain classification ────────────────────────
    iii.trigger({
      function_id: 'brain::classify',
      payload: { model: body.model, messages: body.messages },
    }).then((resp) => {
      logEvent({
        event: 'brain_classification',
        ...(resp as Record<string, unknown>),
      })
    }).catch((err) => {
      logEvent({ event: 'brain_classification_failed', error: String(err) })
    })

    // ── Build deps for routeLlm ─────────────────────────────────────
    const deps: RouteLlmDeps = {
      resolveModel: async (model: string) => {
        const resp = await iii.trigger({ function_id: 'translator::resolve', payload: { model } })
        return resp as { model: string; providers: string[]; resolved: boolean }
      },
      getKey: async (providerId: string) => {
        try {
          const resp = await iii.trigger({ function_id: 'vault::retrieve', payload: { providerId } })
          return (resp as { key?: string }).key ?? null
        } catch {
          return null
        }
      },
      createChannel: async () => iii.createChannel(),
      callProvider: overrides?.callProvider,
    }

    const input: RouteLlmInput = {
      model: body.model,
      messages: body.messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
      stream: body.stream,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
    }

    // ── Route LLM request ───────────────────────────────────────────
    try {
      const result = await routeLlm(input, deps)

      // Streaming path
      if (body.stream && 'stream' in result && result.stream) {
        const streamResult = result as StreamingRouteResult

        res.status(200)
        res.headers({
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        })

        let clientDisconnected = false

        // Handle client disconnect
        const onClose = () => {
          clientDisconnected = true
          streamResult.reader.close()
        }
        res.stream.on('close', onClose)

        // Pipe SSE chunks from channel reader to HTTP response
        streamResult.reader.onMessage((msg: string) => {
          if (clientDisconnected) return
          try {
            res.stream.write(`${msg}\n\n`)
          } catch {
            // Client disconnected mid-stream
            clientDisconnected = true
            streamResult.reader.close()
          }
        })

        // When the channel reader's stream ends, send [DONE] and close
        streamResult.reader.stream.on('end', () => {
          if (clientDisconnected) return
          try {
            res.stream.write('data: [DONE]\n\n')
            res.stream.removeListener('close', onClose)
            res.close()
          } catch {
            // Already closed
          }
        })

        // Log success
        logEvent({
          event: 'route_success',
          model: body.model,
          provider: streamResult.provider,
          stream: true,
        })

        return
      }

      // Non-streaming path
      const routeResult = result as RouteResult
      if (!routeResult.success) {
        logEvent({
          event: 'route_failed',
          model: body.model,
          failures: routeResult.failures,
        })
        writeErrorResponse(res, 502, routeResult.message, 'upstream_error')
        return
      }

      // Format as OpenAI-compatible response
      const response: OpenAICompletionResponse = {
        id: generateRequestId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: (routeResult.response as { content?: string }).content ?? '',
          },
          finish_reason: (routeResult.response as { finishReason?: string }).finishReason ?? 'stop',
        }],
      }

      // Include usage if available
      const usage = (routeResult.response as { usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }).usage
      if (usage) {
        response.usage = {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        }
      }

      logEvent({
        event: 'route_success',
        model: body.model,
        provider: routeResult.provider,
        stream: false,
      })

      writeJSONResponse(res, response)
    } catch (err) {
      logEvent({
        event: 'route_failed',
        model: body.model,
        error: String(err),
      })
      writeErrorResponse(res, 500, `Internal server error: ${String(err)}`, 'server_error')
    }
  })
}
