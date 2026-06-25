import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startHealthEndpoint, waitForHealthEndpoint, type HealthEndpointHandle } from './health-endpoint.ts'

// ── Mocks ──────────────────────────────────────────────────────────────

// Collect health_request log lines so tests can inspect latencyMs
const logLines: string[] = []
const origLog = console.log
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(' ')
  logLines.push(line)
  origLog(...args)
}

// ── Helpers ────────────────────────────────────────────────────────────

async function createEndpoint(
  port = 0,
  model = 'test-model',
  status: 'healthy' | 'degraded' = 'healthy',
): Promise<HealthEndpointHandle> {
  const ep = startHealthEndpoint(port, model, { current: status })
  await waitForHealthEndpoint(ep)
  return ep
}

async function fetchHealth(ep: HealthEndpointHandle): Promise<{
  statusCode: number
  body: Record<string, unknown>
}> {
  const res = await fetch(ep.url)
  const body = await res.json() as Record<string, unknown>
  return { statusCode: res.status, body }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('HealthEndpoint', () => {
  const endpoints: HealthEndpointHandle[] = []

  afterEach(async () => {
    for (const ep of endpoints) {
      await ep.stop().catch(() => {})
    }
    endpoints.length = 0
  })

  it('responds to GET /health with valid JSON', async () => {
    const ep = await createEndpoint()
    endpoints.push(ep)

    const { statusCode, body } = await fetchHealth(ep)

    assert.equal(statusCode, 200)
    assert.equal(body.model, 'test-model')
    assert.equal(body.status, 'healthy')
    assert.ok(typeof body.endpoint === 'string')
    assert.ok(body.endpoint.startsWith('http://127.0.0.1:'))
    assert.ok(typeof body.uptimeSec === 'number')
    assert.ok(body.uptimeSec >= 0)
  })

  it('returns 404 for unknown GET paths', async () => {
    const ep = await createEndpoint()
    endpoints.push(ep)

    const res = await fetch(`http://127.0.0.1:${ep.port}/unknown`)
    assert.equal(res.status, 404)
    const body = await res.json() as Record<string, unknown>
    assert.equal(body.error, 'Not Found')
  })

  it('returns 405 for POST /health', async () => {
    const ep = await createEndpoint()
    endpoints.push(ep)

    const res = await fetch(`http://127.0.0.1:${ep.port}/health`, { method: 'POST' })
    assert.equal(res.status, 405)
    const body = await res.json() as Record<string, unknown>
    assert.equal(body.error, 'Method Not Allowed')
  })

  it('reflects degraded status', async () => {
    const ep = await createEndpoint(0, 'test-model', 'degraded')
    endpoints.push(ep)

    const { statusCode, body } = await fetchHealth(ep)

    assert.equal(statusCode, 200)
    assert.equal(body.status, 'degraded')
  })

  it('stop() closes the server', async () => {
    const ep = await createEndpoint()
    endpoints.push(ep)

    // Verify it's serving
    const { statusCode } = await fetchHealth(ep)
    assert.equal(statusCode, 200)

    // Stop
    await ep.stop()

    // After close, fetch should reject (connection refused)
    await assert.rejects(
      () => fetch(ep.url),
      /connect|ECONNREFUSED|fetch failed/,
    )
  })

  // ── Latency ──────────────────────────────────────────────────

  it('responds within 50ms under single request', async () => {
    const ep = await createEndpoint()
    endpoints.push(ep)

    logLines.length = 0
    const start = Date.now()
    const { statusCode } = await fetchHealth(ep)
    const elapsed = Date.now() - start

    assert.equal(statusCode, 200)
    assert.ok(elapsed < 50, `latency ${elapsed}ms exceeds 50ms limit`)
  })

  // ── Concurrency ───────────────────────────────────────────────

  it('handles 10 concurrent requests', async () => {
    const ep = await createEndpoint()
    endpoints.push(ep)

    const results = await Promise.all(
      Array.from({ length: 10 }, () => fetchHealth(ep)),
    )

    for (const r of results) {
      assert.equal(r.statusCode, 200)
      assert.equal(r.body.status, 'healthy')
      assert.equal(r.body.model, 'test-model')
    }
  })

  // ── Reliability / Leaks ───────────────────────────────────────

  it('handles 100 sequential requests with no socket leaks', async () => {
    const ep = await createEndpoint()
    endpoints.push(ep)

    for (let i = 0; i < 100; i++) {
      const { statusCode } = await fetchHealth(ep)
      assert.equal(statusCode, 200)
    }

    // Stop and verify server closes cleanly (no dangling connections)
    await ep.stop()

    // After close, a new connection should be refused
    await assert.rejects(
      () => fetch(ep.url),
      /connect|ECONNREFUSED|fetch failed/,
    )
  })

  it('handles statusRef mutation after creation', async () => {
    const statusRef = { current: 'healthy' as 'healthy' | 'degraded' }
    const ep = startHealthEndpoint(0, 'test-model', statusRef)
    await waitForHealthEndpoint(ep)
    endpoints.push(ep)

    // Initially healthy
    const r1 = await fetchHealth(ep)
    assert.equal(r1.body.status, 'healthy')

    // Mutate
    statusRef.current = 'degraded'

    const r2 = await fetchHealth(ep)
    assert.equal(r2.body.status, 'degraded')
  })
})
