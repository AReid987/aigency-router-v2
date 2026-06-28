/**
 * cors.test.ts — Unit tests for createCorsMiddleware and getActiveCorsMiddleware.
 *
 * Run: cd workers/gateway && tsx --test src/cors.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCorsMiddleware,
  getActiveCorsMiddleware,
  parseCsv,
} from './middleware.ts'

// ── Helpers ────────────────────────────────────────────────────────────

function mockRequest(overrides: Record<string, any> = {}) {
  return {
    url: '/v1/chat/completions',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }
}

function telemetrySpy() {
  const events: Array<{ class: string; data: any }> = []
  return {
    emit: (eventClass: string, data: any) => {
      events.push({ class: eventClass, data })
    },
    events,
  }
}

const DEFAULT_OPTS = {
  allowedOrigins: ['https://app.example.com'],
  allowedMethods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-admin-token'],
  maxAge: 86400,
  credentials: false,
}

// ── Tests: parseCsv helper ────────────────────────────────────────────

describe('parseCsv', () => {
  it('parses comma-separated values into a trimmed array', () => {
    assert.deepEqual(parseCsv('a, b ,c'), ['a', 'b', 'c'])
  })
  it('returns undefined for empty / unset input', () => {
    assert.equal(parseCsv(undefined), undefined)
    assert.equal(parseCsv(''), undefined)
  })
  it('returns undefined for input that becomes empty after trim', () => {
    assert.equal(parseCsv(' , , '), undefined)
  })
})

// ── Tests: createCorsMiddleware ───────────────────────────────────────

describe('createCorsMiddleware', () => {
  // ── 1. Preflight 204 from allowed origin ─────────────────────────
  it('(1) preflight from allowed origin returns 204 with CORS headers', () => {
    const m = createCorsMiddleware(DEFAULT_OPTS)
    const req = mockRequest({
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
      },
    })
    const result = m(req)
    assert.equal(result.handled, true)
    assert.equal(result.status, 204)
    assert.equal(result.headers!['Access-Control-Allow-Origin'], 'https://app.example.com')
    assert.equal(result.headers!['Access-Control-Allow-Methods'], 'GET, POST')
    assert.equal(result.headers!['Access-Control-Allow-Headers'], 'Content-Type, Authorization, x-api-key, x-admin-token')
    assert.equal(result.headers!['Access-Control-Max-Age'], '86400')
  })

  // ── 2. Disallowed origin: 204 with CORS headers omitted ──────────
  it('(2) preflight from disallowed origin returns 204 with no CORS headers', () => {
    const tel = telemetrySpy()
    const m = createCorsMiddleware({ ...DEFAULT_OPTS, telemetry: tel })
    const req = mockRequest({
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com' },
    })
    const result = m(req)
    assert.equal(result.handled, true)
    assert.equal(result.status, 204)
    assert.equal(result.headers, null)
    assert.equal(tel.events.length, 1)
    assert.equal(tel.events[0].class, 'CORS_PREFLIGHT_REJECTED')
  })

  // ── 3. Allowed origin → headers attached for response ────────────
  it('(3) non-preflight from allowed origin returns CORS headers for response', () => {
    const m = createCorsMiddleware(DEFAULT_OPTS)
    const req = mockRequest({
      method: 'POST',
      headers: { origin: 'https://app.example.com' },
    })
    const result = m(req)
    assert.equal(result.handled, false)
    assert.equal(result.status, 200)
    assert.equal(result.headers!['Access-Control-Allow-Origin'], 'https://app.example.com')
  })

  // ── 4. Disallowed origin → no CORS headers ──────────────────────
  it('(4) non-preflight from disallowed origin returns no CORS headers', () => {
    const m = createCorsMiddleware(DEFAULT_OPTS)
    const req = mockRequest({
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    })
    const result = m(req)
    assert.equal(result.handled, false)
    assert.equal(result.headers, null)
  })

  // ── 5. Preflight without origin → no CORS headers ──────────────
  it('(5) preflight without Origin header returns 204 with no CORS headers', () => {
    const m = createCorsMiddleware(DEFAULT_OPTS)
    const req = mockRequest({
      method: 'OPTIONS',
      headers: {},
    })
    const result = m(req)
    assert.equal(result.handled, true)
    assert.equal(result.status, 204)
    assert.equal(result.headers, null)
  })

  // ── 6. maxAge custom value ───────────────────────────────────────
  it('(6) honors custom maxAge', () => {
    const m = createCorsMiddleware({ ...DEFAULT_OPTS, maxAge: 60 })
    const req = mockRequest({
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com' },
    })
    const result = m(req)
    assert.equal(result.headers!['Access-Control-Max-Age'], '60')
  })

  // ── 7. credentials=true adds the credentials header ─────────────
  it('(7) credentials=true adds Access-Control-Allow-Credentials', () => {
    const m = createCorsMiddleware({ ...DEFAULT_OPTS, credentials: true })
    const req = mockRequest({
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com' },
    })
    const result = m(req)
    assert.equal(result.headers!['Access-Control-Allow-Credentials'], 'true')
  })

  // ── 8. Telemetry emitted on preflight OK ─────────────────────────
  it('(8) emits CORS_PREFLIGHT_OK telemetry on allowed preflight', () => {
    const tel = telemetrySpy()
    const m = createCorsMiddleware({ ...DEFAULT_OPTS, telemetry: tel })
    const req = mockRequest({
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
      },
    })
    m(req)
    assert.equal(tel.events.length, 1)
    assert.equal(tel.events[0].class, 'CORS_PREFLIGHT_OK')
    assert.equal(tel.events[0].data.origin, 'https://app.example.com')
  })

  // ── 9. Multiple allowed origins ─────────────────────────────────
  it('(9) honors multiple allowed origins', () => {
    const m = createCorsMiddleware({
      ...DEFAULT_OPTS,
      allowedOrigins: ['https://a.example.com', 'https://b.example.com'],
    })
    const a = m(mockRequest({ method: 'OPTIONS', headers: { origin: 'https://a.example.com' } }))
    const b = m(mockRequest({ method: 'OPTIONS', headers: { origin: 'https://b.example.com' } }))
    assert.equal(a.headers!['Access-Control-Allow-Origin'], 'https://a.example.com')
    assert.equal(b.headers!['Access-Control-Allow-Origin'], 'https://b.example.com')
  })
})

// ── Tests: getActiveCorsMiddleware (env-gated) ────────────────────────

describe('getActiveCorsMiddleware (env-gated)', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    delete process.env.GATEWAY_CORS
    delete process.env.GATEWAY_CORS_ALLOWED_ORIGINS
    delete process.env.GATEWAY_CORS_ALLOWED_METHODS
    delete process.env.GATEWAY_CORS_ALLOWED_HEADERS
    delete process.env.GATEWAY_CORS_MAX_AGE
    delete process.env.GATEWAY_CORS_CREDENTIALS
  })
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  // ── 10. Default-off: no headers added ───────────────────────────
  it('(10) GATEWAY_CORS unset returns a no-op middleware', () => {
    const m = getActiveCorsMiddleware()
    const result = m(mockRequest({ method: 'OPTIONS', headers: { origin: 'https://x.example.com' } }))
    assert.equal(result.handled, false)
    assert.equal(result.headers, null)
  })

  // ── 11. Gate on but no origins configured → noop ────────────────
  it('(11) GATEWAY_CORS=true but no origins configured returns a no-op', () => {
    process.env.GATEWAY_CORS = 'true'
    const m = getActiveCorsMiddleware()
    const result = m(mockRequest({ method: 'OPTIONS', headers: { origin: 'https://x.example.com' } }))
    assert.equal(result.handled, false)
    assert.equal(result.headers, null)
  })

  // ── 12. Gate on with origins → active middleware ───────────────
  it('(12) GATEWAY_CORS=true with origins returns an active middleware', () => {
    process.env.GATEWAY_CORS = 'true'
    process.env.GATEWAY_CORS_ALLOWED_ORIGINS = 'https://app.example.com,https://demo.example.com'
    const m = getActiveCorsMiddleware()
    const a = m(mockRequest({ method: 'OPTIONS', headers: { origin: 'https://app.example.com' } }))
    const b = m(mockRequest({ method: 'OPTIONS', headers: { origin: 'https://demo.example.com' } }))
    const c = m(mockRequest({ method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }))
    assert.equal(a.headers!['Access-Control-Allow-Origin'], 'https://app.example.com')
    assert.equal(b.headers!['Access-Control-Allow-Origin'], 'https://demo.example.com')
    assert.equal(c.headers, null)
  })
})
