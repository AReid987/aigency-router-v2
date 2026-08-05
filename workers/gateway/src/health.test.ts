/**
 * health.test.ts — Unit tests for the health router.
 *
 * Run: cd workers/gateway && tsx --test src/health.test.ts
 */

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Create a minimal HTTP server that responds 200 OK to HEAD requests.
 * Returns the server instance and its port.
 */
function createOkServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

/**
 * HTTP GET helper — returns status and parsed body.
 */
async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url)
  const body = await res.json() as Record<string, unknown>
  return { status: res.status, body }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('health router', () => {
  let mockVault: http.Server
  let mockSugarDb: http.Server
  let vaultPort: number
  let sugarDbPort: number
  let healthServer: http.Server
  let healthPort: number

  before(async () => {
    // Start mock dependency servers
    const v = await createOkServer()
    mockVault = v.server
    vaultPort = v.port

    const s = await createOkServer()
    mockSugarDb = s.server
    sugarDbPort = s.port
  })

  after(() => {
    mockVault?.close()
    mockSugarDb?.close()
    healthServer?.close()
  })

  // ── 1. GET /health returns 200 with expected fields ──────────────

  it('(1) GET /health returns 200 with status, uptimeMs, version fields', async () => {
    const { createHealthRouter } = await import('./health.ts')

    healthServer = http.createServer((req, res) => {
      createHealthRouter().handleRequest(req, res)
    })

    await new Promise<void>((resolve) => {
      healthServer.listen(0, '127.0.0.1', () => {
        const addr = healthServer.address()
        healthPort = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })

    const { status, body } = await get(`http://127.0.0.1:${healthPort}/health`)
    assert.equal(status, 200)
    assert.equal(body.status, 'ok')
    assert.equal(typeof body.uptimeMs, 'number')
    assert.ok((body.uptimeMs as number) >= 0)
    assert.equal(typeof body.version, 'string')
    // version may be '0.0.0' (fallback) or package version when run via npm scripts
    assert.equal(typeof body.version, 'string')
    assert.ok(body.version.length > 0)
  })

  // ── 2. GET /ready returns 200 when dependencies reachable ────────

  it('(2) GET /ready returns 200 when vault + sugar-db are reachable', async () => {
    healthServer?.close()

    const { createHealthRouter } = await import('./health.ts')

    const router = createHealthRouter({
      vaultUrl: `http://127.0.0.1:${vaultPort}`,
      sugarDbUrl: `http://127.0.0.1:${sugarDbPort}`,
      timeout: 2000,
    })

    healthServer = http.createServer((req, res) => {
      router.handleRequest(req, res)
    })

    await new Promise<void>((resolve) => {
      healthServer.listen(0, '127.0.0.1', () => {
        const addr = healthServer.address()
        healthPort = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })

    const { status, body } = await get(`http://127.0.0.1:${healthPort}/ready`)
    assert.equal(status, 200)
    assert.equal(body.status, 'ready')
    assert.ok(body.checks)
    const checks = body.checks as Record<string, { ok: boolean; latencyMs: number }>
    assert.equal(checks.vault.ok, true)
    assert.equal(checks.sugarDb.ok, true)
    assert.ok(checks.vault.latencyMs >= 0)
    assert.ok(checks.sugarDb.latencyMs >= 0)
  })

  // ── 3. GET /ready returns 503 when sugar-db unreachable ─────────

  it('(3) GET /ready returns 503 when sugar-db is unreachable', async () => {
    healthServer?.close()

    const { createHealthRouter } = await import('./health.ts')

    // Point sugar-db to a bogus port — server is not running there.
    // Fast timeout so the test doesn't wait 2s.
    const router = createHealthRouter({
      vaultUrl: `http://127.0.0.1:${vaultPort}`,
      sugarDbUrl: `http://127.0.0.1:18999`, // unreachable
      timeout: 500, // fast fail
    })

    healthServer = http.createServer((req, res) => {
      router.handleRequest(req, res)
    })

    await new Promise<void>((resolve) => {
      healthServer.listen(0, '127.0.0.1', () => {
        const addr = healthServer.address()
        healthPort = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })

    const { status, body } = await get(`http://127.0.0.1:${healthPort}/ready`)
    assert.equal(status, 503)
    assert.equal(body.status, 'degraded')
    const checks = body.checks as Record<string, { ok: boolean; latencyMs: number }>
    assert.equal(checks.vault.ok, true)
    assert.equal(checks.sugarDb.ok, false)
  })
})
