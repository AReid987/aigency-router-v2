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
import type { RouteResult, RouteSuccess } from './failover.ts'
import { SimpleDAGPlanner, hasCycle, topologicalOrder } from './dag-planner.ts'
import { logTelemetry, type EventClass } from '../../shared/telemetry.ts'
import { QuotaMonitor } from './zero-cost/quota_monitor.ts'
import { InMemoryUsageTracker, UsageTracker } from './zero-cost/usage_tracker.ts'
import type { IUsageTracker } from './zero-cost/usage_tracker.ts'
import { TierClassifier } from './zero-cost/tier_classifier.ts'
import { ZeroCostCircuitBreaker } from './zero-cost/circuit_breaker.ts'
import { createRateLimitMiddleware, createAdminAuthMiddleware, getActiveCorsMiddleware, getActiveSizeLimitMiddleware } from './middleware.ts'
import type { Logger } from './logger.ts'

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

// ── Logger (module-level, set by createChatCompletionsHandler) ────────

let _logger: Logger | null = null

function logEvent(event: Record<string, unknown>): void {
  const msg = (event.event as string) ?? 'http_handler'
  if (_logger) {
    _logger.info(msg, { ...event })
  } else {
    console.log(JSON.stringify({ ...event, timestamp: new Date().toISOString() }))
  }
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
    // Use zero-cost usage tracker when enforcement is active (catches real request counts).
    // Fall back to InMemoryUsageTracker when zero-cost is not enabled.
    const tracker: IUsageTracker = _zcUsageTracker ?? new InMemoryUsageTracker()
    _quotaMonitor = new QuotaMonitor(tracker)
    _quotaMonitor.start()
  }
  return _quotaMonitor
}

// ── Module-level ZeroCostCircuitBreaker (lazy, gated on env var) ──────

let _circuitBreaker: ZeroCostCircuitBreaker | null = null
let _zcUsageTracker: UsageTracker | null = null

function ensureZeroCostBreaker(iii: ISdk): { circuitBreaker: ZeroCostCircuitBreaker; usageTracker: UsageTracker } | null {
  if (process.env.GATEWAY_ZERO_COST_ENFORCEMENT !== 'true') return null
  if (_circuitBreaker === null) {
    const dbPath = process.env.GATEWAY_ZERO_COST_DB_PATH ?? './data/usage.db'
    const tracker = new UsageTracker(dbPath)
    _zcUsageTracker = tracker
    tracker.setFreeTierLimit('groq', parseInt(process.env.GATEWAY_ZERO_COST_GROQ_LIMIT ?? '1000', 10))
    tracker.setFreeTierLimit('cerebras', parseInt(process.env.GATEWAY_ZERO_COST_CEREBRAS_LIMIT ?? '500', 10))
    tracker.setFreeTierLimit('together', parseInt(process.env.GATEWAY_ZERO_COST_TOGETHER_LIMIT ?? '800', 10))
    _circuitBreaker = new ZeroCostCircuitBreaker(tracker, {
      trigger: (target: string, fnName: string, payload: unknown) =>
        iii.trigger({ function_id: fnName, payload: payload as Record<string, unknown> }),
    })
  }
  return { circuitBreaker: _circuitBreaker, usageTracker: _zcUsageTracker! }
}

// ── HTTP Handler ───────────────────────────────────────────────────────

export function createChatCompletionsHandler(
  iii: ISdk,
  overrides?: {
    callProvider?: (...args: any[]) => Promise<any>
    logger?: Logger
  },
) {
  if (overrides?.logger) _logger = overrides.logger
  return http(async (req: HttpRequest, res: HttpResponse) => {
    // The response channel is a Writable backed by a WebSocket. A write that
    // lands after the socket starts closing (client disconnect, or a close
    // racing an in-flight chunk) surfaces asynchronously as an 'error' event,
    // which Node treats as fatal when unhandled — killing the whole worker.
    // try/catch around write() cannot catch it; a listener can.
    res.stream.on?.('error', (err: unknown) => {
      logEvent({ event: 'response_stream_error', error: String(err) })
    })

    // ── CORS Middleware (gated) — position 0 ────────────────────────────
    // Short-circuits on OPTIONS preflight so admin-auth and size-limit never
    // see preflights. Adds CORS headers to actual responses when the
    // request's Origin is in the allow-list.
    const corsTelemetry = {
      emit: (eventClass: string, data: any) => {
        logTelemetry(
          { trigger: (t: string, fn: string, p: unknown) => iii.trigger({ function_id: fn, payload: p as Record<string, unknown> }) },
          { eventClass: eventClass as EventClass, sourceWorker: 'gateway', payload: data },
        ).catch(() => {})
      },
    }
    const corsMiddleware = getActiveCorsMiddleware(corsTelemetry)
    const corsResult = corsMiddleware(req)
    if (corsResult.handled) {
      // Preflight: emit headers and respond
      res.status(corsResult.status)
      if (corsResult.headers) {
        res.headers(corsResult.headers)
      }
      res.stream.end('')
      res.close()
      return
    }
    if (corsResult.headers) {
      // Actual response: attach headers (deferred until response.write)
      for (const [k, v] of Object.entries(corsResult.headers)) {
        res.headers({ [k]: v })
      }
    }

    // ── Size-Limit Middleware (gated) — position 1 ─────────────────────
    // Rejects oversized bodies before they reach the model router. CORS
    // preflight has no body, so it has already short-circuited above.
    const sizeLimitTelemetry = {
      emit: (eventClass: string, data: any) => {
        logTelemetry(
          { trigger: (t: string, fn: string, p: unknown) => iii.trigger({ function_id: fn, payload: p as Record<string, unknown> }) },
          { eventClass: eventClass as EventClass, sourceWorker: 'gateway', payload: data },
        ).catch(() => {})
      },
    }
    const sizeLimitMiddleware = getActiveSizeLimitMiddleware(sizeLimitTelemetry)
    const sizeResult = sizeLimitMiddleware(req)
    if (sizeResult.rejected) {
      res.status(sizeResult.status)
      res.headers({ 'content-type': 'application/json' })
      res.stream.end(sizeResult.body ?? '{"error":"request_too_large"}')
      res.close()
      return
    }

    // ── Admin Auth Middleware (gated) ────────────────────────────────
    if (process.env.GATEWAY_ADMIN_AUTH === 'true' && (req.url ?? req.path ?? '').startsWith('/v1/admin/')) {
      const adminToken = process.env.GATEWAY_ADMIN_TOKEN

      // If admin auth is enabled but no token is configured, deny all
      if (!adminToken) {
        logEvent({ event: 'admin_auth_unconfigured' })
        res.status(401)
        res.headers({ 'www-authenticate': 'Admin-Token' })
        const errorBody: OpenAIErrorResponse = { error: { message: 'Admin authentication required', type: 'auth_error' } }
        res.stream.end(JSON.stringify(errorBody))
        res.close()
        return
      }

      const authMiddleware = createAdminAuthMiddleware({
        token: adminToken,
        telemetry: {
          emit: (eventClass: string, data: any) => {
            logTelemetry(
              { trigger: (t: string, fn: string, p: unknown) => iii.trigger({ function_id: fn, payload: p as Record<string, unknown> }) },
              { eventClass: eventClass as EventClass, sourceWorker: 'gateway', payload: data },
            ).catch(() => {})
          },
        },
      })

      if (!authMiddleware(req)) {
        res.status(401)
        res.headers({ 'www-authenticate': 'Admin-Token' })
        const errorBody: OpenAIErrorResponse = { error: { message: 'Admin authentication required', type: 'auth_error' } }
        res.stream.end(JSON.stringify(errorBody))
        res.close()
        return
      }
    }

    // ── Rate-Limit Middleware (gated) ─────────────────────────────────
    if (process.env.GATEWAY_RATE_LIMITING === 'true' && (req.url ?? req.path ?? '').startsWith('/v1/chat/completions')) {
      const rateLimitMiddleware = createRateLimitMiddleware()
      const result = rateLimitMiddleware(req)

      if (!result.allowed) {
        res.status(429)
        res.headers({
          'retry-after': String(Math.ceil((result.retryAfterMs ?? 60000) / 1000)),
          'x-ratelimit-remaining': '0',
        })
        const errorBody: OpenAIErrorResponse = { error: { message: 'Rate limit exceeded. Try again later.', type: 'rate_limit_error' } }
        res.stream.end(JSON.stringify(errorBody))
        res.close()
        return
      }
    }

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
            // Single end() — see note in the DAG streaming branch below.
            res.stream.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
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

    // Multi-intent execution happens after routing deps are built (below) so
    // sub-tasks share the same resolver, key lookup and zero-cost filtering.
    const isMultiIntent = dag.nodes.length > 1

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
    // Fallback map used only when translator::resolve is unreachable.
    // Keep in sync with workers/translator/src/canonical-maps.ts.
    const CANONICAL_MAP: Record<string, string[]> = {
      'openrouter/free': ['openrouter/free'],
      'mistral-large-latest': ['openrouter/mistralai/mistral-large-2411', 'groq/llama-3.3-70b-versatile'],
      'mistral-small-latest': ['openrouter/mistralai/mistral-small-2409', 'groq/llama-3.1-8b-instant'],
      'llama3-70b': ['groq/llama-3.3-70b-versatile'],
      'llama3': ['groq/llama-3.1-8b-instant', 'together/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'],
      'gpt-oss': ['cerebras/gpt-oss-120b', 'groq/openai/gpt-oss-20b', 'together/openai/gpt-oss-120b'],
      'deepseek-v4-flash': ['openrouter/deepseek/deepseek-chat', 'groq/llama-3.1-8b-instant'],
      'deepseek-v4-pro': ['openrouter/deepseek/deepseek-r1', 'groq/llama-3.3-70b-versatile'],
    }

    const deps: RouteLlmDeps = {
      resolveModel: async (model: string) => {
        try {
          const resp = await iii.trigger({ function_id: 'translator::resolve', payload: { model } })
          return resp as { model: string; providers: string[]; resolved: boolean }
        } catch {
          // Fallback: inline canonical map
          const providers = CANONICAL_MAP[model] || [`openrouter/${model}`]
          return { model, providers, resolved: providers.length > 0 }
        }
      },
      getKey: async (providerId: string) => {
        try {
          const resp = await iii.trigger({ function_id: 'vault::retrieve', payload: { providerId } })
          const key = (resp as { key?: string | null }).key
          if (key) return key
        } catch {
          // vault call failed — fall through to env var
        }
        // Fallback: read from env var
        const envVar = `PROVIDER_KEY_${providerId.split('/')[0].toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`
        return process.env[envVar] ?? null
      },
      createChannel: async () => iii.createChannel(),
      callProvider: overrides?.callProvider,
    }

    // ── Zero-cost enforcement (pre-filter providers) ─────────────
    let _zcUsageRef: UsageTracker | null = null
    if (process.env.GATEWAY_ZERO_COST_ENFORCEMENT === 'true') {
      const zc = ensureZeroCostBreaker(iii)
      if (zc) {
        _zcUsageRef = zc.usageTracker
        const resolved = await deps.resolveModel(body.model as string)
        const resolvedProviders = ((resolved as { providers?: string[] }).providers ?? [])

        const filtered: string[] = []
        const refusedReasons: string[] = []

        for (const providerEntry of resolvedProviders) {
          const providerId = providerEntry.includes('/') ? providerEntry.split('/')[0] : providerEntry
          const cbResult = await zc.circuitBreaker.check(providerId, providerId)
          if (cbResult.allowed) {
            filtered.push(providerEntry)
          } else if (cbResult.reason) {
            refusedReasons.push(cbResult.reason)
          }
        }

        if (filtered.length === 0) {
          const uniqueReasons = [...new Set(refusedReasons)]
          logEvent({
            event: 'zero_cost_all_refused',
            model: body.model,
            reasons: uniqueReasons,
          })
          res.status(503)
          res.headers({ 'content-type': 'application/json' })
          res.stream.end(JSON.stringify({ error: { code: 'no_healthy_provider', reasons: uniqueReasons } }))
          res.close()
          return
        }

        // Override resolveModel to use pre-filtered providers
        deps.resolveModel = async () => ({
          model: body.model,
          providers: filtered,
          resolved: true,
        })
      }
    }

    // ── Multi-intent DAG execution ────────────────────────────────
    // Sub-tasks run in-process via routeLlm rather than through the engine:
    // the DAG's nodes target gateway::chat_completions, and the engine refuses
    // to route a function back to the worker that registered it (loop guard),
    // so self-invocation always fails with NOT_FOUND.
    if (isMultiIntent) {
      try {
        const order = topologicalOrder(dag)
        const ordered = order.map((id) => dag.nodes.find((n) => n.id === id)!)
        const contents: string[] = []

        for (const node of ordered) {
          const nodeMessages = (node.payload.messages as ChatCompletionsRequest['messages'] | undefined)
            ?? body.messages
          const subResult = await routeLlm({
            model: body.model,
            messages: nodeMessages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
            maxTokens: body.max_tokens,
            temperature: body.temperature,
          }, deps) as RouteResult

          if (!subResult.success) {
            throw new Error(subResult.message ?? 'sub-task routing failed')
          }
          // Sub-tasks consume real provider quota — record it, or zero-cost
          // accounting silently undercounts every multi-intent request.
          if (_zcUsageRef) {
            const tokens = (subResult.response as { usage?: { totalTokens: number } })?.usage?.totalTokens ?? 0
            _zcUsageRef.record(subResult.provider, subResult.provider, tokens)
          }
          contents.push((subResult.response as { content?: string })?.content ?? '')
        }

        logEvent({ event: 'dag_aggregated', nodes: dag.nodes.length, order })

        const aggregatedContent = contents.join('\n\n')

        // Honour the client's Accept contract: a stream:true request must get
        // SSE back, not JSON.
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
            choices: [{ index: 0, delta: { content: aggregatedContent }, finish_reason: 'stop' }],
          }
          // Single end() — a second write() would race the channel close and
          // emit an async 'error' on the writable (which kills the worker).
          res.stream.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
          res.close()
          return
        }

        writeJSONResponse(res, {
          id: generateRequestId(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: aggregatedContent },
            finish_reason: 'stop',
          }],
        })
        return
      } catch (err) {
        logEvent({ event: 'dag_aggregation_failed', error: String(err) })
        writeErrorResponse(res, 500, `DAG aggregation failed: ${err}`)
        return
      }
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

      // ── Record usage for zero-cost enforcement ──────────────────
      if (_zcUsageRef) {
        if (!('stream' in result) && 'success' in result && (result as RouteResult).success) {
          const routeResult = result as RouteSuccess
          const tokens = (routeResult.response as { usage?: { totalTokens: number } })?.usage?.totalTokens ?? 0
          _zcUsageRef.record(routeResult.provider, routeResult.provider, tokens)
        } else if ('stream' in result && (result as StreamingRouteResult).stream) {
          const streamResult = result as StreamingRouteResult
          _zcUsageRef.record(streamResult.provider, streamResult.provider, 0)
        }
      }

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
        // The channel pipe already emits the SSE sentinel; track it so we
        // don't append a second `data: [DONE]` when the stream ends.
        let doneSent = false

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
            if (msg.trim() === 'data: [DONE]') doneSent = true
            res.stream.write(`${msg}\n\n`)
          } catch {
            // Client disconnected mid-stream
            clientDisconnected = true
            streamResult.reader.close()
          }
        })

        // ChannelReader.onMessage() only registers a callback — the underlying
        // reader socket is opened lazily by the first stream read. Resume the
        // stream so the connection is established and messages actually flow.
        streamResult.reader.stream.resume()

        // When the channel reader's stream ends, send [DONE] and close
        streamResult.reader.stream.on('end', () => {
          if (clientDisconnected) return
          try {
            if (!doneSent) res.stream.write('data: [DONE]\n\n')
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
