/**
 * middleware.test.ts — Unit tests for rate-limit and admin-auth middleware.
 *
 * Run: cd workers/gateway && tsx --test src/middleware.test.ts
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Helpers ────────────────────────────────────────────────────────────

function mockRequest(overrides: Record<string, any> = {}) {
  return {
    url: '/v1/chat/completions',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {},
    body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }
}

// ── Tests: Rate-Limit Middleware ───────────────────────────────────────

describe('createRateLimitMiddleware', () => {
  // ── Case 1: allowed — passes through the limiter result ──────────
  it('(1) calls the underlying limiter and returns its allowed=true result', async () => {
    const { createRateLimitMiddleware } = await import('./middleware.ts')

    const middleware = createRateLimitMiddleware({
      keyExtractor: () => 'test-key',
      limiter: { consume: (_k: string) => ({ allowed: true, remaining: 99 }) },
    })

    const req = mockRequest()
    const result = middleware(req)

    assert.equal(result.allowed, true)
    assert.equal(result.remaining, 99)
  })

  // ── Case 2: denied — passes through the limiter result ───────────
  it('(2) returns allowed=false result when limiter denies', async () => {
    const { createRateLimitMiddleware } = await import('./middleware.ts')

    const middleware = createRateLimitMiddleware({
      keyExtractor: () => 'test-key',
      limiter: {
        consume: (_k: string) => ({
          allowed: false,
          remaining: 0,
          retryAfterMs: 30000,
        }),
      },
    })

    const req = mockRequest()
    const result = middleware(req)

    assert.equal(result.allowed, false)
    assert.equal(result.remaining, 0)
    assert.equal(result.retryAfterMs, 30000)
  })

  // ── Default key extractor ─────────────────────────────────────────
  it('uses default key extractor: x-api-key -> remoteAddress -> anonymous', async () => {
    const { createRateLimitMiddleware } = await import('./middleware.ts')

    const capturedKeys: string[] = []
    const middleware = createRateLimitMiddleware({
      limiter: {
        consume: (k: string) => {
          capturedKeys.push(k)
          return { allowed: true, remaining: 99 }
        },
      },
    })

    // With x-api-key header
    const req1 = mockRequest({ headers: { 'x-api-key': 'key-abc' } })
    middleware(req1)
    assert.equal(capturedKeys[0], 'key-abc')

    // Without x-api-key — falls back to remoteAddress
    const req2 = mockRequest({ headers: {} })
    middleware(req2)
    assert.equal(capturedKeys[1], '127.0.0.1')

    // Without x-api-key or remoteAddress — falls back to 'anonymous'
    const req3 = mockRequest({ headers: {}, socket: {} })
    middleware(req3)
    assert.equal(capturedKeys[2], 'anonymous')
  })
})

// ── Tests: Admin Auth Middleware ───────────────────────────────────────

describe('createAdminAuthMiddleware', () => {
  // ── Case 3: gate off when token is undefined ──────────────────────
  it('(3) returns true when token is undefined (gate off)', async () => {
    const { createAdminAuthMiddleware } = await import('./middleware.ts')

    const middleware = createAdminAuthMiddleware({ token: undefined })
    const req = mockRequest({ url: '/v1/admin/quota' })

    assert.equal(middleware(req), true)
  })

  it('returns true when token is empty string (gate off)', async () => {
    const { createAdminAuthMiddleware } = await import('./middleware.ts')

    const middleware = createAdminAuthMiddleware({ token: '' })
    const req = mockRequest({ url: '/v1/admin/quota' })

    assert.equal(middleware(req), true)
  })

  // ── Case 4: matching token ────────────────────────────────────────
  it('(4) returns true when x-admin-token header matches configured token', async () => {
    const { createAdminAuthMiddleware } = await import('./middleware.ts')

    const middleware = createAdminAuthMiddleware({ token: 'secret-123' })
    const req = mockRequest({
      url: '/v1/admin/quota',
      headers: { 'x-admin-token': 'secret-123' },
    })

    assert.equal(middleware(req), true)
  })

  // ── Case 5: missing header ────────────────────────────────────────
  it('(5) returns false when x-admin-token header is missing', async () => {
    const { createAdminAuthMiddleware } = await import('./middleware.ts')

    const middleware = createAdminAuthMiddleware({ token: 'secret-123' })
    const req = mockRequest({ url: '/v1/admin/quota' })

    assert.equal(middleware(req), false)
  })

  // ── Case 6: wrong token ──────────────────────────────────────────
  it('(6) returns false when x-admin-token header does not match', async () => {
    const { createAdminAuthMiddleware } = await import('./middleware.ts')

    const middleware = createAdminAuthMiddleware({ token: 'secret-123' })
    const req = mockRequest({
      url: '/v1/admin/quota',
      headers: { 'x-admin-token': 'wrong-token' },
    })

    assert.equal(middleware(req), false)
  })

  // ── Case 7: constant-time comparison ──────────────────────────────
  it('(7) uses crypto.timingSafeEqual (constant-time comparison), not ===', async () => {
    const { createAdminAuthMiddleware } = await import('./middleware.ts')

    const middleware = createAdminAuthMiddleware({ token: 'super-secret' })
    const req = mockRequest({
      url: '/v1/admin/quota',
      headers: { 'x-admin-token': 'super-secret' },
    })

    // First check: functional test passes
    assert.equal(middleware(req), true)

    // Second check: source-level grep confirms timingSafeEqual usage
    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const source = fs.readFileSync(path.join(__dirname, 'middleware.ts'), 'utf-8')

    assert.ok(
      source.includes('crypto.timingSafeEqual'),
      'middleware.ts must use crypto.timingSafeEqual for constant-time comparison',
    )

    assert.ok(
      !source.includes('configuredToken === headerToken'),
      'middleware.ts must NOT use === against the stored token',
    )
  })

  // ── Telemetry emission on rejection ───────────────────────────────
  it('emits AUTH_REJECTED telemetry on rejection when telemetry is provided', async () => {
    const { createAdminAuthMiddleware } = await import('./middleware.ts')

    const emitted: Array<{ eventClass: string; data: any }> = []
    const middleware = createAdminAuthMiddleware({
      token: 'secret-123',
      telemetry: {
        emit: (eventClass: string, data: any) => {
          emitted.push({ eventClass, data })
        },
      },
    })

    const req = mockRequest({
      url: '/v1/admin/quota',
      method: 'GET',
    })

    assert.equal(middleware(req), false)
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].eventClass, 'AUTH_REJECTED')
    assert.equal(emitted[0].data.path, '/v1/admin/quota')
    assert.equal(emitted[0].data.method, 'GET')
    assert.equal(emitted[0].data.reason, 'missing_token')
  })
})
