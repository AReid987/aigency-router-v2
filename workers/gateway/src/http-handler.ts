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
import { SimpleDAGPlanner, hasCycle, topologicalOrder } from './dag-planner.ts'
import { logTelemetry, type EventClass } from '../../shared/telemetry.ts'
import { QuotaMonitor } from './zero-cost/quota_monitor.ts'
import { InMemoryUsageTracker } from './zero-cost/usage_tracker.ts'
import type { IUsageTracker } from './zero-cost/usage_tracker.ts'

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

// ── Module-level QuotaMonitor (lazy, gated on env var) ─────────────────

let _quotaMonitor: QuotaMonitor | null = null

function ensureQuotaMonitor(): QuotaMonitor | null {
  if (process.env.GATEWAY_QUOTA_MONITORING !== 'true') return null
  if (_quotaMonitor === null) {
    const tracker = new InMemoryUsageTracker()
    _quotaMonitor = new QuotaMonitor(tracker)
    _quotaMonitor.start()
  }
  return _quotaMonitor
}

// ── HTTP Handler ───────────────────────────────────────────────────────

export function createChatCompletionsHandler(iii: ISdk, overrides?: { callProvider?: (...args: any[]) => Promise<any> }) {
  return http(async (req: HttpRequest, res: HttpResponse) => {
    // ── Admin route: GET /v1/admin/quota (gated) ──────────────────
    if (req.method === 'GET' && (req.path === '/v1/admin/quota' || req.url === '/v1/admin/quota')) {
      const monitor = ensureQuotaMonitor()
      if (monitor === null) {
        writeErrorResponse(res, 404, 'Not found')
        return
      }
      const status = monitor.getStatus()
      res.status(200)
      res.headers({ 'content-type': 'application/json' })
      res.stream.end(JSON.stringify(status))
      res.close()
      return
    }

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

    // ── Gate: Complex-request gating via Engram pipeline (opt-in) ──
    const useEngramPipeline = process.env.GATEWAY_USE_ENGRAM_PIPELINE === 'true'

    if (useEngramPipeline) {
      const telemetryTrigger = (target: string, fnName: string, payload: unknown) =>
        iii.trigger({ function_id: fnName, payload: payload as Record<string, unknown> })

      try {
        const classifyResult = await iii.trigger({
          function_id: 'brain::classify',
          payload: { model: body.model, messages: body.messages },
        }) as { classification: string; confidence: number }

        logTelemetry({ trigger: telemetryTrigger }, {
          eventClass: 'GATEWAY_CLASSIFY_DECISION',
          sourceWorker: 'gateway',
          payload: {
            classification: classifyResult.classification,
            confidence: classifyResult.confidence,
            requestId: generateRequestId(),
            model: body.model,
          },
        }).catch(() => {})

        if (classifyResult.classification === 'COMPLEX') {
          logTelemetry({ trigger: telemetryTrigger }, {
            eventClass: 'GATEWAY_ENGRAM_PIPELINE_TRIGGERED',
            sourceWorker: 'gateway',
            payload: { requestId: generateRequestId(), reason: 'complex_request' },
          }).catch(() => {})

          const engramResult = await iii.trigger({
            function_id: 'engram::orchestrate',
            payload: { model: body.model, messages: body.messages },
          }) as Record<string, unknown>

          const content = typeof engramResult?.content === 'string'
            ? engramResult.content
            : JSON.stringify(engramResult)

          if (body.stream) {
            res.status(200)
            res.headers({
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
            })
            const chunk = {
              id: generateRequestId(),
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
            }
            res.stream.write(`data: ${JSON.stringify(chunk)}\n\n`)
            res.stream.write('data: [DONE]\n\n')
            res.close()
            return
          }

          const response: OpenAICompletionResponse = {
            id: generateRequestId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            }],
          }
          writeJSONResponse(res, response)
          return
        }

        // SIMPLE — emit telemetry and fall through to existing handler
        logTelemetry({ trigger: telemetryTrigger }, {
          eventClass: 'GATEWAY_FAST_PATH',
          sourceWorker: 'gateway',
          payload: { requestId: generateRequestId(), reason: 'simple_request' },
        }).catch(() => {})
      } catch (err) {
        logEvent({ event: 'gateway_pipeline_classify_failed', error: String(err) })
        // Fall through to existing handler
      }
    }

    // ── DAG planning (decompose multi-intent requests) ────────────
    const planner = new SimpleDAGPlanner()
    const dag = planner.plan({ model: body.model, messages: body.messages })

    if (hasCycle(dag)) {
      logEvent({ event: 'dag_cycle_rejected', nodes: dag.nodes.length })
      writeErrorResponse(res, 400, 'Request DAG contains a cycle')
      return
    }

    if (dag.nodes.length > 1) {
      // Multi-intent request — execute nodes in topological order via iii-sdk trigger.
      // Aggregator collects results and returns combined OpenAI response.
      try {
        const ordered = topologicalOrder(dag).map((id) => dag.nodes.find((n) => n.id === id)!)
        const subResults: unknown[] = []
        for (const node of ordered) {
          const subResp = await iii.trigger({
            function_id: node.function_id,
            payload: node.payload,
          })
          subResults.push(subResp)
        }
        const aggregated = subResults[subResults.length - 1] as Record<string, unknown>
        logEvent({
          event: 'dag_aggregated',
          nodes: dag.nodes.length,
          order: topologicalOrder(dag),
        })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: typeof aggregated?.['content'] === 'string'
                  ? (aggregated['content'] as string)
                  : JSON.stringify(aggregated),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }))
        return
      } catch (err) {
        logEvent({ event: 'dag_aggregation_failed', error: String(err) })
        writeErrorResponse(res, 500, `DAG aggregation failed: ${err}`)
        return
      }
    }

    // ── Fire-and-forget brain classification (skipped when engram pipeline is active) ─
    if (!useEngramPipeline) {
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
    }

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
