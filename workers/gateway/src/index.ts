import http from 'node:http'
import { registerWorker, type ISdk, type StreamChannelRef, ChannelReader } from 'iii-sdk'
import { FailoverEngine, type RouteResult } from './failover.ts'
import { callProvider, type Message, type StreamChunk, type ProviderResponse } from './provider-client.ts'
import { logTelemetry, type EventClass } from '../../shared/telemetry.ts'
import { createChatCompletionsHandler } from './http-handler.ts'
import { callEngramHeal, HEAL_TIMEOUT_MS } from './heal-integration.ts'
import { createLogger, type Logger } from './logger.ts'
import { createHealthRouter } from './health.ts'
import { createGracefulShutdown } from './lifecycle.ts'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

// ── Module-level Logger ────────────────────────────────────────────────

/** Module-level logger — set once at startup by startGateway. */
let _logger: Logger = createLogger()

export function __setLogger(l: Logger) { _logger = l }

// ── Structured Logging (delegates to pino logger) ──────────────────────

function logEvent(event: Record<string, unknown>): void {
  const msg = (event.event as string) ?? 'gateway'
  const { event: _evt, ...fields } = event
  _logger.info(msg, fields)
}

// ── Streaming Types ────────────────────────────────────────────────────

interface ChannelWriter {
  sendMessage(msg: string): void
  close(): void
}

export interface StreamingRouteResult {
  stream: true
  channelRef: StreamChannelRef
  reader: ChannelReader
  provider: string
}

function buildSSEChunk(chunk: StreamChunk): string {
  const ssePayload = {
    id: chunk.id,
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { content: chunk.delta },
      finish_reason: chunk.finishReason,
    }],
  }
  return `data: ${JSON.stringify(ssePayload)}`
}

async function pipeStreamToChannel(
  stream: AsyncGenerator<StreamChunk>,
  writer: ChannelWriter,
): Promise<void> {
  try {
    for await (const chunk of stream) {
      writer.sendMessage(buildSSEChunk(chunk))
    }
    writer.sendMessage('data: [DONE]')
    writer.close()
  } catch (err) {
    logEvent({ event: 'stream_error', error: String(err) })
    writer.sendMessage(`data: ${JSON.stringify({ error: 'stream interrupted' })}`)
    writer.sendMessage('data: [DONE]')
    writer.close()
  }
}

async function streamWithFailover(
  providerArray: string[],
  model: string,
  messages: Message[],
  deps: RouteLlmDeps,
  options: { maxTokens?: number; temperature?: number },
): Promise<StreamingRouteResult | RouteResult> {
  const failures: { provider: string; status: number | null; reason: string }[] = []

  // Import getProviderConfig and ProviderError
  const { getProviderConfig, ProviderError } = await import('./provider-client.ts')

  for (const providerModel of providerArray) {
    const slashIdx = providerModel.indexOf('/')
    const providerId = slashIdx === -1 ? providerModel : providerModel.slice(0, slashIdx)
    const providerModelName = slashIdx === -1 ? model : providerModel.slice(slashIdx + 1)

    const apiKey = await deps.getKey(providerId)
    if (apiKey == null) {
      failures.push({ provider: providerId, status: null, reason: 'no API key available' })
      continue
    }

    const config = getProviderConfig(providerId)
    if (config == null) {
      failures.push({ provider: providerId, status: null, reason: 'unknown provider' })
      continue
    }

    try {
      logEvent({ event: 'streaming_started', model, provider: providerId })
      const providerFn = deps.callProvider ?? callProvider
      const result = await providerFn(config, apiKey, providerModelName, messages, {
        stream: true,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      })

      // Create iii Channel and pipe stream
      const channel = await deps.createChannel!()
      pipeStreamToChannel(result as AsyncGenerator<StreamChunk>, channel.writer)
        .then(() => logEvent({ event: 'streaming_ended', model, provider: providerId }))

      return { stream: true, channelRef: channel.writerRef, reader: channel.reader, provider: providerId }
    } catch (err: unknown) {
      if (err instanceof ProviderError) {
        const status = err.status
        if (status === 429) {
          failures.push({ provider: providerId, status, reason: 'rate limited' })
        } else if (status === 403) {
          failures.push({ provider: providerId, status, reason: 'forbidden/revoked' })
        } else if (status === 500 || status === 503) {
          failures.push({ provider: providerId, status, reason: 'server error' })
        } else if (status === 401) {
          failures.push({ provider: providerId, status, reason: 'invalid API key' })
        } else {
          failures.push({ provider: providerId, status, reason: `HTTP ${status}` })
        }
      } else {
        failures.push({ provider: providerId, status: null, reason: String(err) })
      }
    }
  }

  return {
    success: false,
    message: `All ${failures.length} provider(s) failed`,
    failures,
  }
}

// ── Gateway Route LLM (testable without iii) ─────────────────────────

export interface RouteLlmInput {
  model: string
  messages: Message[]
  stream?: boolean
  maxTokens?: number
  temperature?: number
}

export interface RouteLlmDeps {
  resolveModel: (model: string) => Promise<{ model: string; providers: string[]; resolved: boolean }>
  getKey: (providerId: string) => Promise<string | null>
  createChannel?: () => Promise<{ writer: { sendMessage: (msg: string) => void; close: () => void }; reader: ChannelReader; writerRef: StreamChannelRef }>
  callProvider?: typeof callProvider
  /** iii SDK instance — required when callEngramHeal is provided. */
  iii?: ISdk
  /** Optional: factory to create a callHeal fn injected into FailoverEngine.tryHeal. */
  callEngramHeal?: (iii: ISdk, timeoutMs: number) => (jsonString: string, timeoutMs: number) => Promise<unknown>
  /** Optional: provider config lookup for FailoverEngine. Defaults to provider-client registry. */
  getProviderConfig?: (providerId: string) => { baseUrl: string; envKey: string } | undefined
}

/**
 * Core LLM routing logic — separated for testability.
 * In production, resolveModel calls translator::resolve and getKey calls vault::retrieve.
 */
export async function routeLlm(
  input: RouteLlmInput,
  deps: RouteLlmDeps,
): Promise<RouteResult | StreamingRouteResult> {
  const { model, messages, stream, maxTokens, temperature } = input

  // 1. Resolve canonical model name → provider array
  const resolved = await deps.resolveModel(model)
  logEvent({
    event: 'model_resolved',
    model,
    resolved: resolved.resolved,
    providerCount: resolved.providers.length,
  })

  if (resolved.providers.length === 0) {
    const failure: RouteResult = {
      success: false,
      message: `No providers found for model "${model}"`,
      failures: [],
    }
    logEvent({ event: 'route_failed', model, error: failure.message })
    return failure
  }

  // 2. Streaming path: create iii Channel, iterate providers manually, stream chunks
  if (stream && deps.createChannel) {
    return streamWithFailover(resolved.providers, model, messages, deps, {
      maxTokens,
      temperature,
    })
  }

  // 3. Non-streaming path: use FailoverEngine
  const engine = new FailoverEngine(deps.getKey, deps.callProvider ?? callProvider, deps.getProviderConfig)
  // Wire callEngramHeal into FailoverEngine.tryHeal so empty provider responses
  // trigger a heal round-trip via engram::heal_json before falling through.
  if (deps.callEngramHeal && deps.iii) {
    engine.tryHeal = async (rawBody) => {
      const callHeal = deps.callEngramHeal!(deps.iii!, HEAL_TIMEOUT_MS)
      const healed = await callHeal(rawBody, HEAL_TIMEOUT_MS)
      if (healed == null || typeof healed !== 'object') return null
      const obj = healed as { repaired?: unknown }
      if (typeof obj.repaired !== 'string') return null
      return {
        id: 'chatcmpl-healed',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        content: obj.repaired,
        choices: [{ index: 0, message: { role: 'assistant', content: obj.repaired }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as unknown as ProviderResponse
    }
  }
  const result = await engine.routeWithFailover(resolved.providers, model, messages, {
    stream,
    maxTokens,
    temperature,
  })

  // 4. Log outcome
  if (result.success) {
    logEvent({
      event: 'route_success',
      model,
      provider: result.provider,
      failoverTriggered: result.provider !== resolved.providers[0]?.split('/')[0],
    })
  } else {
    logEvent({
      event: 'route_failed',
      model,
      failureCount: result.failures.length,
      failures: result.failures,
    })
  }

  return result
}

// ── Gateway Worker ─────────────────────────────────────────────────────

export function createGatewayWorker(url: string = ENGINE_URL): ISdk {
  const iii = registerWorker(url, { workerName: 'gateway' })

  iii.registerFunction('gateway::echo', async (input: { message?: string }) => {
    return { echo: input?.message ?? 'pong', worker: 'gateway', timestamp: Date.now() }
  })

  iii.registerFunction('gateway::status', async () => {
    return { worker: 'gateway', status: 'healthy', uptime: process.uptime() }
  })

  iii.registerFunction('gateway::route', async (input: { target: string; payload?: unknown }) => {
    const result = await iii.trigger({ function_id: input.target, payload: input.payload ?? {} })
    return { routed_to: input.target, result }
  })

  // ── HTTP endpoint: POST /v1/chat/completions ──────────────────────
  iii.registerTrigger({
    type: 'http',
    function_id: 'gateway::chat_completions',
    config: { api_path: '/v1/chat/completions', http_method: 'POST' },
  })
  iii.registerFunction('gateway::chat_completions', createChatCompletionsHandler(iii, { logger: _logger }))

  iii.registerFunction('gateway::route_llm', async (input: RouteLlmInput) => {
    logEvent({ event: 'route_llm_request', model: input.model })

    // Build telemetry trigger that wraps sdk.trigger
    const telemetryTrigger = (target: string, fnName: string, payload: unknown) =>
      iii.trigger({ function_id: fnName, payload: payload as Record<string, unknown> })

    const result = await routeLlm(input, {
      resolveModel: async (model) => {
        const resp = await iii.trigger({ function_id: 'translator::resolve', payload: { model } })
        return resp as { model: string; providers: string[]; resolved: boolean }
      },
      getKey: async (providerId) => {
        try {
          const resp = await iii.trigger({ function_id: 'vault::retrieve', payload: { providerId } })
          return (resp as { key?: string }).key ?? null
        } catch {
          return null
        }
      },
      createChannel: async () => iii.createChannel(),
      callEngramHeal,
      iii,
    })

    // Fire-and-forget telemetry — emit routing events to SugarDB
    if (result.success) {
      logTelemetry({ trigger: telemetryTrigger }, {
        eventClass: 'FAST_TRACK_ROUTE',
        sourceWorker: 'gateway',
        payload: { model: input.model, provider: (result as RouteResult).provider ?? 'unknown' },
      }).catch(() => {}) // already handled inside logTelemetry
    } else if ('failures' in result) {
      // Check for 429 rate-limit failures
      const has429 = (result as RouteResult).failures?.some((f: { status: number | null }) => f.status === 429)
      if (has429) {
        logTelemetry({ trigger: telemetryTrigger }, {
          eventClass: 'QUOTA_WARNING',
          sourceWorker: 'gateway',
          payload: { model: input.model, failureCount: (result as RouteResult).failures.length },
        }).catch(() => {})
      }
    }

    return result
  })

  return iii
}

// ── Start Gateway ──────────────────────────────────────────────────────

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const logger = createLogger()
  __setLogger(logger)

  // Health server — for K8s/Docker liveness and readiness probes.
  const HEALTH_PORT = parseInt(process.env.GATEWAY_HEALTH_PORT ?? '9090', 10)
  const healthRouter = createHealthRouter({
    telemetry: {
      emit: (eventClass: string) => {
        logger.info('health_telemetry', { eventClass })
      },
    },
  })

  const healthServer = http.createServer((req, res) => {
    healthRouter.handleRequest(req, res)
  })

  healthServer.listen(HEALTH_PORT, () => {
    logger.info('health server listening', { port: HEALTH_PORT })
  })

  // Graceful shutdown for health server
  const shutdown = createGracefulShutdown(healthServer, { logger })

  const iii = createGatewayWorker()
  logger.info('worker registered', { url: ENGINE_URL })

  // Unregister graceful shutdown on process exit
  process.on('exit', () => {
    shutdown.unregister()
  })
}
