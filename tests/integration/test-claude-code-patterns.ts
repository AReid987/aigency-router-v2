/**
 * test-claude-code-patterns.ts — E2E integration test for TS SDK with
 * Claude Code usage patterns.
 *
 * Spawns a real Node.js child process using the TS SDK (from M014) with:
 *   1. System prompt + 4-turn conversation with streaming
 *   2. Tool definitions passed through to the gateway
 *   3. SDK retry on 5xx (mock server returns 500 twice then 200)
 *   4. AbortSignal cancels mid-stream
 *
 * Uses a MockProviderServer (simple HTTP server) to simulate the gateway
 * without needing a real iii Engine.
 *
 * Run: cd workers/gateway && tsx ../tests/integration/test-claude-code-patterns.ts
 *
 * Or (from repo root):
 *   node_modules/.bin/tsx tests/integration/test-claude-code-patterns.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

// ── Constants ──────────────────────────────────────────────────────────

const TSX = resolve('node_modules/.bin/tsx')
const SCRIPT_PATH = resolve('tests/integration/scripts/claude-code-test-script.ts')

// ── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let _requestCounter = 0
function nextChatId(): string {
  _requestCounter++
  return `chatcmpl-test-${_requestCounter}`
}

/**
 * Parse a JSON line from the spawned script's stdout.
 */
interface ScriptOutput {
  passed: number
  failed: number
  details: string[]
  [key: string]: unknown
}

function parseOutputLine(line: string): ScriptOutput | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as ScriptOutput
  } catch {
    return null
  }
}

/**
 * Send an SSE-formatted streaming response through the HTTP response.
 */
async function sendSSEStream(
  res: http.ServerResponse,
  model: string,
  chunks: string[],
  delayMs: number,
): Promise<void> {
  const chatId = nextChatId()
  const created = Math.floor(Date.now() / 1000)

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    const chunkData = JSON.stringify({
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: isLast ? {} : { content: chunks[i] },
          finish_reason: isLast ? 'stop' : null,
        },
      ],
    })
    res.write(`data: ${chunkData}\n\n`)
    if (delayMs > 0) await sleep(delayMs)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * Send a non-streaming JSON response.
 */
function sendJSONResponse(res: http.ServerResponse, model: string, extra: Record<string, unknown> = {}): void {
  const chatId = nextChatId()
  const created = Math.floor(Date.now() / 1000)
  const body = {
    id: chatId,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Mock response from test server',
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...extra,
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ── MockProviderServer ─────────────────────────────────────────────────
//
// A lightweight HTTP server that simulates the gateway for the spawned
// SDK test script. Routes responses based on the `model` field in the
// request body.

interface RequestLogEntry {
  method: string
  path: string
  body: Record<string, unknown>
  timestamp: number
}

class MockProviderServer {
  public server: http.Server
  public url: string = ''
  public requestLog: RequestLogEntry[] = []
  private port: number = 0

  /** Per-model retry attempt counters */
  private retryCounters: Map<string, number> = new Map()

  /**
   * Set to true when a streaming request for the abort test is received.
   * The spawned script aborts mid-stream, so the server detects the
   * connection close.
   */
  public abortDetected: boolean = false

  constructor() {
    this.server = http.createServer(this.onRequest.bind(this))
  }

  async start(): Promise<string> {
    return new Promise((resolvePromise) => {
      this.server.listen(0, () => {
        const addr = this.server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          this.url = `http://127.0.0.1:${this.port}`
          resolvePromise(this.url)
        }
      })
    })
  }

  stop(): void {
    this.server.close()
  }

  reset(): void {
    this.requestLog = []
    this.retryCounters.clear()
    this.abortDetected = false
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Handle favicon requests (avoid noise)
    if (req.url === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    // GET /v1/models — return dummy model list
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: [
          { id: 'test/multi-turn', object: 'model', created: 1, owned_by: 'test' },
          { id: 'test/tool-defs', object: 'model', created: 1, owned_by: 'test' },
          { id: 'test/retry-5xx', object: 'model', created: 1, owned_by: 'test' },
          { id: 'test/abort-test', object: 'model', created: 1, owned_by: 'test' },
        ],
      }))
      return
    }

    // Only handle POST /v1/chat/completions
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end()
      return
    }

    // Read request body
    let bodyStr = ''
    req.on('data', (chunk: Buffer) => { bodyStr += chunk.toString() })
    req.on('end', () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(bodyStr)
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
        return
      }

      // Log the request
      this.requestLog.push({
        method: 'POST',
        path: '/v1/chat/completions',
        body,
        timestamp: Date.now(),
      })

      const model = (body.model as string) ?? 'unknown'
      const isStream = body.stream === true

      // Route by model name
      if (model === 'test/multi-turn') {
        this.handleMultiTurn(res, model, isStream)
      } else if (model === 'test/tool-defs') {
        this.handleToolDefs(res, model)
      } else if (model === 'test/retry-5xx') {
        this.handleRetry5xx(res, model, body)
      } else if (model === 'test/abort-test') {
        this.handleAbortTest(req, res, model)
      } else {
        // Fallback: return streaming or plain response
        if (isStream) {
          sendSSEStream(res, model, ['Default mock response'], 0)
        } else {
          sendJSONResponse(res, model)
        }
      }
    })
  }

  // ── Multi-turn conversation handler ────────────────────────────
  // Returns streaming chunks for each turn.

  private handleMultiTurn(res: http.ServerResponse, model: string, isStream: boolean): void {
    if (isStream) {
      // Return 3 chunks per streaming response
      sendSSEStream(res, model, [
        'Paris is the capital of France. ',
        'It is known for its rich history, culture, and iconic landmarks.',
      ], 5)
    } else {
      sendJSONResponse(res, model, { content: 'Paris is the capital of France.' })
    }
  }

  // ── Tool definitions handler ──────────────────────────────────
  // Returns a non-streaming response confirming tool definitions
  // were received (verification happens via request log).

  private handleToolDefs(res: http.ServerResponse, model: string): void {
    sendJSONResponse(res, model, {
      content: 'I can help you check the weather. Please provide a location.',
    })
  }

  // ── Retry on 5xx handler ──────────────────────────────────────
  // Returns 500 for the first 2 attempts, then 200.

  private handleRetry5xx(res: http.ServerResponse, model: string, body: Record<string, unknown>): void {
    // Use a key derived from the request content to track retries independently
    const messages = body.messages as Array<{ content: string }> | undefined
    const key = messages?.[0]?.content ?? 'default'
    const count = (this.retryCounters.get(key) ?? 0) + 1
    this.retryCounters.set(key, count)

    if (count <= 2) {
      // Return 500 — SDK should retry
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          message: 'Simulated server error',
          type: 'server_error',
          code: 500,
        },
      }))
    } else {
      // Return success after retries
      this.retryCounters.delete(key)
      sendJSONResponse(res, model, {
        content: 'Response after retry',
      })
    }
  }

  // ── AbortSignal handler ───────────────────────────────────────
  // Starts streaming, then detects when the client disconnects.

  private handleAbortTest(req: http.IncomingMessage, res: http.ServerResponse, model: string): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })

    const chatId = nextChatId()
    const created = Math.floor(Date.now() / 1000)

    // Send a couple of chunks with delays
    const chunk1 = JSON.stringify({
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: 'This is the ' }, finish_reason: null }],
    })
    const chunk2 = JSON.stringify({
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: 'first part of ' }, finish_reason: null }],
    })

    res.write(`data: ${chunk1}\n\n`)

    // Write the second chunk after a small delay
    setTimeout(() => {
      // If the client has disconnected, this write may fail silently
      try { res.write(`data: ${chunk2}\n\n`) } catch { /* client disconnected */ }

      // Try to write a final chunk and [DONE] — may fail if client already aborted
      const finalChunk = JSON.stringify({
        id: chatId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
      try {
        res.write(`data: ${finalChunk}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } catch { /* client disconnected — expected */ }
    }, 100)

    // Detect client disconnect
    req.on('close', () => {
      this.abortDetected = true
    })
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('TS SDK e2e with Claude Code usage patterns', () => {
  let server: MockProviderServer
  let serverUrl: string

  before(async () => {
    server = new MockProviderServer()
    serverUrl = await server.start()
  })

  after(() => {
    if (server) server.stop()
  })

  // ── 1. Streaming Claude Code-style conversation works ─────────

  it('1. Streaming Claude Code-style conversation works', async () => {
    server.reset()

    const { lines, exitCode } = await runScript(serverUrl)

    assert.equal(exitCode, 0, 'Script must exit with code 0')

    const result = lines.find((l) => l !== null && typeof l.passed === 'number')
    assert.ok(result, 'Must have result JSON output')
    assert.equal(result.failed, 0, 'All scenarios must pass')

    // Multi-turn verification: check request log
    const multiTurnLogs = server.requestLog.filter(
      (log) => (log.body.model as string) === 'test/multi-turn',
    )
    assert.equal(multiTurnLogs.length, 4, 'Must have 4 multi-turn requests')

    // Verify context preservation — each request's messages array grows
    const msgLengths = multiTurnLogs.map(
      (log) => (log.body.messages as Array<unknown>).length,
    )
    assert.equal(msgLengths[0], 2, 'Turn 1: 2 messages (system + user)')
    assert.ok(msgLengths[1] > msgLengths[0], 'Turn 2: messages array grew')
    assert.ok(msgLengths[2] > msgLengths[1], 'Turn 3: messages array grew')
    assert.ok(msgLengths[3] > msgLengths[2], 'Turn 4: messages array grew')

    // Verify first turn has system prompt
    const firstMessages = multiTurnLogs[0].body.messages as Array<Record<string, unknown>>
    assert.equal(firstMessages[0].role, 'system', 'First message must be system prompt')
    assert.ok(
      (firstMessages[0].content as string).length > 0,
      'System prompt must not be empty',
    )
    assert.equal(firstMessages[1].role, 'user', 'Second message must be user message')
  })

  // ── 2. Tool definitions passed through to gateway ─────────────

  it('2. Tool definitions passed through to gateway', async () => {
    server.reset()

    const { lines, exitCode } = await runScript(serverUrl)

    assert.equal(exitCode, 0, 'Script must exit with code 0')

    const result = lines.find((l) => l !== null && typeof l.passed === 'number')
    assert.ok(result, 'Must have result JSON output')

    // Verify tools param was in the request body
    const toolDefsLogs = server.requestLog.filter(
      (log) => (log.body.model as string) === 'test/tool-defs',
    )
    assert.ok(toolDefsLogs.length >= 1, 'Must have tool-defs request')

    const toolDefsBody = toolDefsLogs[0].body
    assert.ok(
      Array.isArray(toolDefsBody.tools),
      'Request must contain tools array',
    )
    assert.ok(toolDefsBody.tools.length >= 1, 'Tools array must have at least one tool')

    const firstTool = (toolDefsBody.tools as Array<Record<string, unknown>>)[0]
    assert.ok(firstTool.type === 'function', 'Tool must have type "function"')
    assert.ok(
      (firstTool.function as Record<string, unknown>).name === 'getWeather',
      'Tool function must be named getWeather',
    )
  })

  // ── 3. Multi-turn context preserved across requests ───────────

  it('3. Multi-turn context preserved across requests', async () => {
    server.reset()

    const { lines, exitCode } = await runScript(serverUrl)

    assert.equal(exitCode, 0, 'Script must exit with code 0')

    // Detailed multi-turn context analysis
    const multiTurnLogs = server.requestLog.filter(
      (log) => (log.body.model as string) === 'test/multi-turn',
    )

    // Turn 1: 2 messages (system + user1)
    const turn1Msgs = multiTurnLogs[0].body.messages as Array<Record<string, unknown>>
    assert.equal(turn1Msgs.length, 2, 'Turn 1 has 2 messages')

    // Verify system prompt is present in all turns
    for (let i = 0; i < multiTurnLogs.length; i++) {
      const msgs = multiTurnLogs[i].body.messages as Array<Record<string, unknown>>
      assert.equal(msgs[0].role, 'system', `Turn ${i + 1}: system prompt preserved at index 0`)
      assert.ok(
        typeof msgs[0].content === 'string' && (msgs[0].content as string).length > 0,
        `Turn ${i + 1}: system prompt content not empty`,
      )
    }

    // Verify alternating user/assistant pattern
    for (let i = 0; i < multiTurnLogs.length; i++) {
      const msgs = multiTurnLogs[i].body.messages as Array<Record<string, unknown>>
      for (let j = 1; j < msgs.length; j++) {
        const expectedRole = (j - 1) % 2 === 0 ? 'user' : 'assistant'
        assert.equal(
          msgs[j].role,
          expectedRole,
          `Turn ${i + 1}, msg ${j + 1}: expected role '${expectedRole}', got '${msgs[j].role}'`,
        )
      }
    }

    // Verify each assistant response has non-empty content
    for (let i = 0; i < multiTurnLogs.length; i++) {
      const msgs = multiTurnLogs[i].body.messages as Array<Record<string, unknown>>
      // Assistant messages are at odd indices after index 0
      for (let j = 2; j < msgs.length; j += 2) {
        if (msgs[j]?.role === 'assistant') {
          assert.ok(
            typeof msgs[j].content === 'string' && (msgs[j].content as string).length > 0,
            `Turn ${i + 1}: assistant content at index ${j} not empty`,
          )
        }
      }
    }
  })

  // ── 4. Retry on 5xx works ────────────────────────────────────

  it('4. SDK retry on 5xx works (mock returns 500 twice then 200)', async () => {
    server.reset()

    const { lines, exitCode } = await runScript(serverUrl)

    assert.equal(exitCode, 0, 'Script must exit with code 0')

    // Verify retry pattern: at least 3 requests to test/retry-5xx
    const retryLogs = server.requestLog.filter(
      (log) => (log.body.model as string) === 'test/retry-5xx',
    )
    assert.ok(retryLogs.length >= 3, `Must have at least 3 retry requests, got ${retryLogs.length}`)

    // The last request to retry-5xx should succeed
    // We can't directly check status code from the log, but we know the script
    // passes this scenario (exit code 0 + failed: 0), and the server's retry
    // counter shows at least 3 attempts for the first retry key
  })

  // ── 5. AbortSignal cancels mid-stream ─────────────────────────

  it('5. AbortSignal cancels mid-stream', async () => {
    server.reset()

    const { lines, exitCode } = await runScript(serverUrl)

    assert.equal(exitCode, 0, 'Script must exit with code 0')

    // Verify abort test request was made
    const abortLogs = server.requestLog.filter(
      (log) => (log.body.model as string) === 'test/abort-test',
    )
    assert.ok(abortLogs.length >= 1, 'Must have abort-test request')

    // Verify the server detected client disconnect
    assert.ok(server.abortDetected, 'Server must detect client disconnect during abort')

    // Verify result reports abort test passed
    const result = lines.find((l) => l !== null && typeof l.passed === 'number')
    assert.ok(result, 'Must have result JSON output')

    const abortDetail = result.details.find((d: string) => d.includes('AbortSignal'))
    assert.ok(abortDetail, 'Result details must mention AbortSignal')
    assert.ok(abortDetail.startsWith('PASS'), 'AbortSignal test must pass')
  })

  // ── 6. End-to-end JSON parses correctly ───────────────────────

  it('6. End-to-end JSON result parses correctly', async () => {
    server.reset()

    const { lines, exitCode } = await runScript(serverUrl)

    assert.equal(exitCode, 0, 'Script must exit with code 0')

    const result = lines.find((l) => l !== null && typeof l.passed === 'number')
    assert.ok(result, 'Must have result JSON output')

    // Validate result shape
    assert.equal(typeof result.passed, 'number', 'passed must be a number')
    assert.equal(typeof result.failed, 'number', 'failed must be a number')
    assert.ok(Array.isArray(result.details), 'details must be an array')

    assert.equal(result.passed, 4, 'All 4 scenarios must pass')
    assert.equal(result.failed, 0, 'Zero failures')

    // Verify all 4 PASS details exist
    const passDetails = result.details.filter((d: string) => d.startsWith('PASS'))
    assert.equal(passDetails.length, 4, 'Must have 4 PASS detail lines')

    // Verify each scenario is represented
    const detailText = result.details.join(' ')
    assert.ok(detailText.includes('multi-turn'), 'Must mention multi-turn')
    assert.ok(detailText.includes('Tool definitions'), 'Must mention tool definitions')
    assert.ok(detailText.includes('retry'), 'Must mention retry')
    assert.ok(detailText.includes('AbortSignal'), 'Must mention AbortSignal')
  })
})

// ── Spawn Helper ───────────────────────────────────────────────────────

interface RunScriptResult {
  lines: ScriptOutput[]
  exitCode: number
}

async function runScript(gatewayUrl: string): Promise<RunScriptResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TSX, [SCRIPT_PATH], {
      env: {
        ...process.env,
        GATEWAY_URL: gatewayUrl,
        PATH: process.env.PATH,
      },
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
        reject(new Error(`Script stderr (exit ${code}): ${stderr.join('')}`))
        return
      }

      resolvePromise({ lines, exitCode: code ?? -1 })
    })

    child.on('error', (err) => {
      reject(err)
    })
  })
}
