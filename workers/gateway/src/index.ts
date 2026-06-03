import { registerWorker, type ISdk, type StreamChannelRef } from 'iii-sdk'
import { FailoverEngine, type RouteResult } from './failover.ts'
import { callProvider, type Message, type StreamChunk, type ProviderResponse } from './provider-client.ts'
import { logTelemetry, type EventClass } from '../../shared/telemetry.ts'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'

// ── Structured Logging ─────────────────────────────────────────────────

interface GatewayLogEvent {
  timestamp: string
  event: string
  model?: string
  resolved?: boolean
  providerCount?: number
  provider?: string
  failoverTriggered?: boolean
  result?: string
  failureCount?: number
  error?: string
  [key: string]: unknown
}

function logEvent(event: GatewayLogEvent): void {
  console.log(JSON.stringify({ ...event, timestamp: event.timestamp ?? new Date().toISOString() }))
}

// ── Streaming Types ────────────────────────────────────────────────────

interface ChannelWriter {
  sendMessage(msg: string): void
  close(): void
}

export interface StreamingRouteResult {
  stream: true
  channelRef: StreamChannelRef
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

      return { stream: true, channelRef: channel.writerRef, provider: providerId }
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
  createChannel?: () => Promise<{ writer: { sendMessage: (msg: string) => void; close: () => void }; writerRef: StreamChannelRef }>
  callProvider?: typeof callProvider
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
  const engine = new FailoverEngine(deps.getKey, deps.callProvider ?? callProvider)
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

// Start if run directly
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const iii = createGatewayWorker()
  console.log('[gateway] Worker registered — listening on', ENGINE_URL)

  process.on('SIGTERM', async () => {
    await iii.shutdown()
    process.exit(0)
  })
}
