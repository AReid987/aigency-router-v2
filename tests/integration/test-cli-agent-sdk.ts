/**
 * test-cli-agent-sdk — E2E integration test.
 *
 * Spawns a real CLI agent process (using the TS SDK from S01) against a
 * mock gateway with zero-cost enforcement enabled. Verifies:
 *
 *   (a) Non-streaming SDK request returns valid OpenAI-format response
 *   (b) Streaming SDK request returns SSE chunks with accumulated content
 *   (c) SDK request after groq exhaust falls through to cerebras
 *   (d) GET /v1/admin/quota reflects request usage
 *   (e) Zero-cost enforcement: paid provider (openai) is refused
 *
 * Run: tsx tests/integration/test-cli-agent-sdk.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { UsageTracker } from '../../workers/gateway/src/zero-cost/usage_tracker.ts'
import { ZeroCostCircuitBreaker } from '../../workers/gateway/src/zero-cost/circuit_breaker.ts'
import { QuotaMonitor } from '../../workers/gateway/src/zero-cost/quota_monitor.ts'
import { TierClassifier } from '../../workers/gateway/src/zero-cost/tier_classifier.ts'

// ── Constants ──────────────────────────────────────────────────────────

const TSX = resolve('node_modules/.bin/tsx')
const SCRIPT_PATH = resolve('tests/integration/scripts/sdk-cli-agent.ts')

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Parse a "provider/model" string into { provider, modelName }.
 */
function parseProviderModel(model: string): { provider: string; modelName: string } {
  const slashIdx = model.indexOf('/')
  if (slashIdx === -1) return { provider: 'unknown', modelName: model }
  return {
    provider: model.slice(0, slashIdx),
    modelName: model.slice(slashIdx + 1),
  }
}

/**
 * Generate a fake streaming response — mimics an OpenAI streaming chunk.
 */
function makeStreamChunk(id: string, content: string, finishReason: string | null, model: string): string {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * Generate a fake non-streaming response body.
 */
function makeJSONResponse(id: string, content: string, model: string): string {
  const body = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: content.length, total_tokens: 10 + content.length },
  }
  return JSON.stringify(body)
}

/**
 * Parse a JSON line from the child process stdout.
 */
interface ScriptOutput {
  type: string
  [key: string]: unknown
}

function parseOutputLine(line: string): ScriptOutput | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  try {
    return JSON.parse(trimmed) as ScriptOutput
  } catch {
    return null
  }
}

/**
 * Spawn the SDK client script and collect its output.
 */
async function runScript(env: Record<string, string>): Promise<{ lines: ScriptOutput[]; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TSX, [SCRIPT_PATH], {
      env: { ...process.env, ...env, PATH: process.env.PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    })

    const stdout: string[] = []
    const stderr: string[] = []

    child.stdout.on('data', (data: Buffer) => {
      stdout.push(data.toString())
    })

    child.stderr.on('data', (data: Buffer) => {
      stderr.push(data.toString())
    })

    child.on('close', (code) => {
      const fullStdout = stdout.join('')
      const lines = fullStdout
        .split('\n')
        .map(parseOutputLine)
        .filter((l): l is ScriptOutput => l !== null)

      if (stderr.length > 0 && lines.length === 0) {
        reject(new Error(`Script stderr output (exit ${code}): ${stderr.join('')}`))
        return
      }

      resolvePromise({ lines, exitCode: code ?? -1 })
    })

    child.on('error', (err) => {
      reject(err)
    })
  })
}

/**
 * Build an OpenAI-compatible error response body.
 */
function makeErrorResponse(status: number, message: string, type: string = 'invalid_request_error'): string {
  return JSON.stringify({
    error: { message, type },
  })
}

// ── Mock Gateway Server ────────────────────────────────────────────────

class MockGatewayServer {
  public server: http.Server
  public usageTracker: UsageTracker
  public circuitBreaker: ZeroCostCircuitBreaker
  public quotaMonitor: QuotaMonitor
  public url: string = ''
  private port: number = 0

  /**
   * Pre-configured per-provider free-tier limits.
   * Tests can adjust these before calling start().
   */
  public providerLimits: Record<string, number> = {
    groq: 10,
    cerebras: 100,
    openai: 0, // paid — always refused
  }

  /**
   * Pre-recorded usage count per provider (for simulating prior usage).
   */
  public preRecorded: Record<string, number> = {}

  /**
   * Provider fallback order for the mock gateway.
   * When the primary provider is refused by the circuit breaker,
   * the server tries the fallback providers in order.
   */
  public fallbackOrder: Record<string, string[]> = {
    groq: ['cerebras'],
    cerebras: ['groq'],
    openai: [],   // paid — no fallback
  }

  constructor() {
    this.usageTracker = new UsageTracker(':memory:')
    this.circuitBreaker = new ZeroCostCircuitBreaker(this.usageTracker, {
      trigger: async (_target: string, _fnName: string, input: unknown) => {
        // Telemetry capture — no-op for this test
      },
    })
    this.quotaMonitor = new QuotaMonitor(this.usageTracker)
    this.server = this.createServer()
  }

  private createServer(): http.Server {
    return http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('access-control-allow-origin', '*')

      // ── GET /v1/admin/quota ─────────────────────────────────────
      if (req.method === 'GET' && (req.url === '/v1/admin/quota' || req.url === '/quota')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        const status = this.quotaMonitor.getStatus()
        res.end(JSON.stringify(status))
        return
      }

      // ── POST /v1/chat/completions ───────────────────────────────
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let bodyStr = ''
        for await (const chunk of req) {
          bodyStr += chunk.toString()
        }

        let body: { model?: string; messages?: unknown[]; stream?: boolean }
        try {
          body = JSON.parse(bodyStr)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(makeErrorResponse(400, 'Invalid JSON body'))
          return
        }

        if (!body.model) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(makeErrorResponse(400, "Missing required field: 'model'"))
          return
        }

        // Parse primary provider from model string
        const { provider: primaryProvider } = parseProviderModel(body.model)
        const requestedModel = body.model

        // Build the provider try-order: primary first, then fallbacks
        const providerTryOrder = [
          primaryProvider,
          ...(this.fallbackOrder[primaryProvider] ?? []),
        ]

        let chosenProvider: string | null = null

        // Try each provider until one is allowed by the circuit breaker
        for (const candidate of providerTryOrder) {
          const cbResult = await this.circuitBreaker.check(candidate, candidate)
          if (cbResult.allowed) {
            chosenProvider = candidate
            break
          }
        }

        if (chosenProvider === null) {
          // All providers refused
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(makeErrorResponse(429, 'All available providers refused by zero-cost enforcement', 'all_refused'))
          return
        }

        // ── Record usage for the chosen provider ─────────────────
        this.usageTracker.record(chosenProvider, chosenProvider, 10)

        // ── Respond with model name matching the request ─────────
        if (body.stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          })

          const requestId = `chatcmpl-mock-${Date.now()}`

          // Send a few chunks then [DONE]
          res.write(makeStreamChunk(requestId, `Mock response from ${chosenProvider} `, null, requestedModel))
          res.write(makeStreamChunk(requestId, '(streaming)', 'stop', requestedModel))
          res.write('data: [DONE]\n\n')
          res.end()
        } else {
          const requestId = `chatcmpl-mock-${Date.now()}`
          const content = `Mock response from ${chosenProvider}`
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(makeJSONResponse(requestId, content, requestedModel))
        }
        return
      }

      // ── 404 ────────────────────────────────────────────────────
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }))
    })
  }

  /**
   * Apply the configured provider limits to the usage tracker.
   */
  private applyLimits(): void {
    for (const [provider, limit] of Object.entries(this.providerLimits)) {
      this.usageTracker.setFreeTierLimit(provider, limit)
    }
  }

  /**
   * Apply pre-recorded usage to the usage tracker.
   */
  private applyPreRecorded(): void {
    for (const [provider, count] of Object.entries(this.preRecorded)) {
      for (let i = 0; i < count; i++) {
        this.usageTracker.record(provider, provider, 10)
      }
    }
  }

  async start(): Promise<string> {
    return new Promise((resolvePromise) => {
      this.applyLimits()
      this.applyPreRecorded()

      this.server.listen(0, () => {
        const addr = this.server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          this.url = `http://127.0.0.1:${this.port}`
          this.quotaMonitor.start()
          resolvePromise(this.url)
        }
      })
    })
  }

  stop(): void {
    this.quotaMonitor.stop()
    this.server.close()
    this.usageTracker.close()
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('CLI Agent SDK End-to-End (zero-cost enforcement)', () => {
  let server: MockGatewayServer
  let serverUrl: string

  before(async () => {
    server = new MockGatewayServer()
    serverUrl = await server.start()
  })

  after(() => {
    if (server) server.stop()
  })

  // ── (a) Non-streaming SDK request end-to-end ──────────────────────

  it('(a) Non-streaming SDK request returns valid OpenAI-format response', async () => {
    const { lines, exitCode } = await runScript({
      GATEWAY_URL: serverUrl,
      MODE: 'nonstream',
      MODEL: 'groq/gpt-4',
    })

    assert.equal(exitCode, 0, 'Script must exit with code 0')

    const result = lines.find(l => l.type === 'nonstream_result')
    assert.ok(result, 'Must have nonstream_result output line')
    assert.ok(typeof result.id === 'string', 'id must be a string')
    assert.ok((result.id as string).startsWith('chatcmpl-'), `id must start with chatcmpl-, got ${result.id}`)
    assert.equal(result.object, 'chat.completion', 'object must be chat.completion')
    assert.equal(result.model, 'groq/gpt-4', 'model must match')
    assert.ok(typeof result.content === 'string', 'content must be a string')
    assert.ok((result.content as string).length > 0, 'content must not be empty')
    assert.equal(result.finish_reason, 'stop', 'finish_reason must be stop')
    assert.equal(result.has_usage, true, 'usage must be present')
  })

  // ── (b) Streaming SDK request end-to-end ──────────────────────────

  it('(b) Streaming SDK request returns SSE chunks with accumulated content', async () => {
    const { lines, exitCode } = await runScript({
      GATEWAY_URL: serverUrl,
      MODE: 'stream',
      MODEL: 'groq/gpt-4',
    })

    assert.equal(exitCode, 0, 'Script must exit with code 0')

    const result = lines.find(l => l.type === 'stream_result')
    assert.ok(result, 'Must have stream_result output line')
    assert.ok(typeof result.chunk_count === 'number', 'chunk_count must be a number')
    assert.ok((result.chunk_count as number) >= 1, 'Must have at least 1 chunk')
    assert.ok(typeof result.full_content === 'string', 'full_content must be a string')
    assert.ok((result.full_content as string).length > 0, 'full_content must not be empty')
    assert.ok(typeof result.first_chunk_id === 'string', 'first_chunk_id must be a string')
    assert.equal(result.last_finish_reason, 'stop', 'last_finish_reason must be stop')
  })

  // ── (c) SDK request after groq exhausted — falls through to cerebras ──

  it('(c) SDK request with exhausted groq falls through to cerebras', async () => {
    // Create a server with groq limit=1 (will be exhausted immediately)
    const exhaustServer = new MockGatewayServer()
    exhaustServer.providerLimits = { groq: 1, cerebras: 100, openai: 0 }
    const exhaustUrl = await exhaustServer.start()

    try {
      const { lines, exitCode } = await runScript({
        GATEWAY_URL: exhaustUrl,
        MODE: 'exhaust-nonstream',
        MODEL: 'groq/gpt-4',
        REQUEST_COUNT: '5',
      })

      // The mock gateway returns fake responses for all providers,
      // so ALL 5 requests succeed (1 from groq, 4 from cerebras fallback).
      // With zero-cost enforcement, groq is exhausted after 1 request.
      assert.equal(exitCode, 0, 'Script must exit with code 0')

      const exhaustResult = lines.find(l => l.type === 'exhaust_result')
      assert.ok(exhaustResult, 'Must have exhaust_result output line')

      const results = exhaustResult.results as Array<{ request: number; success: boolean; error?: string }>
      assert.ok(Array.isArray(results), 'results must be an array')
      assert.equal(results.length, 5, 'Must have 5 result entries')

      // All should succeed — the mock gateway doesn't refuse exhausted free-tier
      // (the circuit breaker refuses, but since the mock server responds to all
      // requests as long as the CB allows, requests for cerebras will succeed)
      const failures = results.filter(r => !r.success)
      assert.equal(failures.length, 0, 'All requests must succeed')

      // Verify groq had 1 usage and cerebras had 4
      const status = exhaustServer.quotaMonitor.getStatus()
      const groqStatus = status.providers.find(p => p.name === 'groq')
      const cerebrasStatus = status.providers.find(p => p.name === 'cerebras')

      assert.ok(groqStatus, 'groq must be in quota status')
      assert.equal(groqStatus.current, 1, 'groq must have 1 request (exhausted)')
      assert.equal(groqStatus.utilization_pct, 100, 'groq must be at 100% utilization')

      assert.ok(cerebrasStatus, 'cerebras must be in quota status')
      assert.ok(cerebrasStatus.current >= 4, 'cerebras must handle remaining requests')
    } finally {
      exhaustServer.stop()
    }
  })

  // ── (d) SDK getQuotaStatus call works ─────────────────────────────

  it('(d) getQuotaStatus returns correct provider utilization', async () => {
    // Make some requests first to build up usage
    await runScript({
      GATEWAY_URL: serverUrl,
      MODE: 'nonstream',
      MODEL: 'cerebras/gpt-4',
    })

    // Now check quota
    const { lines, exitCode } = await runScript({
      GATEWAY_URL: serverUrl,
      MODE: 'quota',
    })

    assert.equal(exitCode, 0, 'Script must exit with code 0')

    const quotaResult = lines.find(l => l.type === 'quota_status')
    assert.ok(quotaResult, 'Must have quota_status output line')

    const providers = quotaResult.providers as Array<{ name: string; current: number; limit: number; utilization_pct: number }>
    assert.ok(Array.isArray(providers), 'providers must be an array')

    // At least groq and cerebras should be present
    const groqEntry = providers.find(p => p.name === 'groq')
    assert.ok(groqEntry, 'groq must be in quota')
    assert.ok(typeof groqEntry.current === 'number', 'groq current must be number')

    // cerebras should have at least 1 from the request above
    const cerebrasEntry = providers.find(p => p.name === 'cerebras')
    assert.ok(cerebrasEntry, 'cerebras must be in quota')
    assert.ok(cerebrasEntry.current >= 1, 'cerebras must have at least 1 request counted')
  })

  // ── (e) Zero-cost enforcement: paid provider refused ──────────────

  it('(e) Paid provider (openai) is refused by zero-cost enforcement', async () => {
    const { lines, exitCode } = await runScript({
      GATEWAY_URL: serverUrl,
      MODE: 'paid-refused',
      MODEL: 'openai/gpt-4',
    })

    // The script should exit with code 0 (we caught the error and reported it)
    assert.equal(exitCode, 0, 'Script must exit with code 0')

    const refusedLine = lines.find(l => l.type === 'paid_refused')
    assert.ok(refusedLine, 'Must have paid_refused output line')
    assert.ok(typeof refusedLine.error === 'string', 'error message must be a string')
    assert.ok((refusedLine.error as string).length > 0, 'error message must not be empty')

    // Verify openai was never recorded in usage
    const status = server.quotaMonitor.getStatus()
    const openaiStatus = status.providers.find(p => p.name === 'openai')
    // openai might not be present at all (zero usage, not configured as free-tier)
    if (openaiStatus) {
      assert.equal(openaiStatus.current, 0, 'openai must have zero usage')
    }

    // Make sure no unexpected success line
    const unexpectedSuccess = lines.find(l => l.type === 'paid_refused_unexpected_success')
    assert.ok(!unexpectedSuccess, 'Must not have unexpected success for paid provider')
  })

  // ── (f) All providers routed correctly, paid never reached ────────

  it('(f) All zero-cost preserved — no paid provider ever used', async () => {
    // Verify across the entire server session
    const status = server.quotaMonitor.getStatus()

    // groq should have some usage from test (a) and (b)
    const groqEntry = status.providers.find(p => p.name === 'groq')
    assert.ok(groqEntry, 'groq must be in quota status')
    assert.ok(groqEntry.current >= 2, `groq must have at least 2 requests across tests (got ${groqEntry.current})`)

    // openai must have zero usage across all tests
    const openaiEntry = status.providers.find(p => p.name === 'openai')
    if (openaiEntry) {
      assert.equal(openaiEntry.current, 0, 'openai must have zero usage (zero-cost enforcement)')
    }
  })
})
