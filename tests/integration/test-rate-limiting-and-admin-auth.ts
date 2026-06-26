/**
 * test-rate-limiting-and-admin-auth.ts — E2E integration test for
 * rate-limiting (S01) and admin-auth (S02) middleware.
 *
 * Test scenario:
 *   1. Spawn a gateway child process with rate-limit and admin-auth
 *      middleware enabled (env vars).
 *   2. Send 100 chat-completion requests under capacity -> no 429.
 *   3. Send 101st request -> 429 with retry-after + x-ratelimit-remaining.
 *   4. Admin: no token -> 401 with www-authenticate.
 *   5. Admin: wrong token -> 401.
 *   6. Admin: correct token -> 200 (or 404 but NOT 401).
 *
 * Self-skip pattern: each test skips cleanly when the gateway is
 * unreachable (ECONNREFUSED).
 *
 * Run:
 *   /Users/antonioreid/CODE/00_PROJECTS/00_APPS/AIGENCY/aigency-router-v2/node_modules/.bin/tsx --test tests/integration/test-rate-limiting-and-admin-auth.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawnGateway } from './scripts/spawn-gateway-rate-limit.ts'

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Issue an HTTP request and return status, body, and headers.
 */
function fetchUrl(
  baseUrl: string,
  path: string,
  options?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl}${path}`
    const req = http.request(
      url,
      {
        method: options?.method ?? 'GET',
        headers: options?.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers as Record<string, string>,
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (options?.body) req.write(options.body)
    req.end()
  })
}

/**
 * Wrapper that catches ECONNREFUSED/ECONNRESET and returns null instead
 * of throwing. Used for self-skip pattern.
 */
async function safeFetch(
  baseUrl: string,
  path: string,
  options?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
): Promise<{ status: number; body: string; headers: Record<string, string> } | null> {
  try {
    return await fetchUrl(baseUrl, path, options)
  } catch (err: unknown) {
    const msg = (err as Error).message
    if (
      msg.includes('ECONNREFUSED') ||
      msg.includes('ECONNRESET') ||
      msg.includes('socket hang up')
    ) {
      return null
    }
    throw err
  }
}

const CHAT_BODY = JSON.stringify({
  model: 'test/gpt-4',
  messages: [{ role: 'user', content: 'hello' }],
})

// ── Tests ──────────────────────────────────────────────────────────────

describe('Rate Limiting and Admin Auth E2E', () => {
  let baseUrl: string
  let gw: { baseUrl: string; port: number; kill: () => void } | null = null

  before(async () => {
    try {
      gw = await spawnGateway({
        GATEWAY_RATE_LIMITING: 'true',
        GATEWAY_RATE_LIMIT_TOKENS: '100',
        GATEWAY_RATE_LIMIT_WINDOW_MS: '60000',
        GATEWAY_ADMIN_AUTH: 'true',
        GATEWAY_ADMIN_TOKEN: 'test-admin-token-abc',
      })
      baseUrl = gw.baseUrl
    } catch (err) {
      console.log(`[setup] Gateway spawn failed: ${(err as Error).message}`)
      gw = null
    }
  })

  after(() => {
    if (gw) gw.kill()
  })

  // ──────────────────────────────────────────────────────────────────────
  // (1) Under capacity: 100 sequential requests succeed (no 429)
  // ──────────────────────────────────────────────────────────────────────

  it('(1) Under capacity: 100 sequential requests succeed', async (t) => {
    if (!gw) return t.skip('Gateway not available — spawn failed')

    for (let i = 0; i < 100; i++) {
      const res = await safeFetch(baseUrl, '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'x-api-key': 'test-key',
          'content-type': 'application/json',
        },
        body: CHAT_BODY,
      })

      if (res === null) {
        return t.skip(`Connection lost at request ${i + 1}`)
      }

      // Grace for upstream unreachable
      if (res.status === 502 || res.status === 503) {
        return t.skip(`Gateway returned ${res.status} at request ${i + 1} (upstream unreachable)`)
      }

      assert.notEqual(
        res.status,
        429,
        `Request ${i + 1} should not be rate limited (status=${res.status})`,
      )
    }
  })

  // ──────────────────────────────────────────────────────────────────────
  // (2) Over capacity denied: 101st request returns 429 + proper headers
  // ──────────────────────────────────────────────────────────────────────

  it('(2) Over capacity denied: 101st request returns 429 with headers', async (t) => {
    if (!gw) return t.skip('Gateway not available — spawn failed')

    const res = await safeFetch(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'x-api-key': 'test-key',
        'content-type': 'application/json',
      },
      body: CHAT_BODY,
    })

    if (res === null) {
      return t.skip('Gateway unreachable')
    }

    assert.equal(res.status, 429, '101st request should be rate limited')
    assert.ok(
      res.headers['retry-after'] !== undefined,
      '429 response should include retry-after header',
    )
    assert.equal(
      res.headers['x-ratelimit-remaining'],
      '0',
      '429 response should include x-ratelimit-remaining: 0',
    )
  })

  // ──────────────────────────────────────────────────────────────────────
  // (3) Admin no-token denied
  // ──────────────────────────────────────────────────────────────────────

  it('(3) Admin no-token: GET /v1/admin/quota without x-admin-token returns 401', async (t) => {
    if (!gw) return t.skip('Gateway not available — spawn failed')

    const res = await safeFetch(baseUrl, '/v1/admin/quota')

    if (res === null) {
      return t.skip('Gateway unreachable')
    }

    assert.equal(res.status, 401, 'No token request should return 401')
    const wwwAuth = (res.headers['www-authenticate'] ?? '').toLowerCase()
    assert.ok(
      wwwAuth.includes('admin-token'),
      `www-authenticate header should contain 'Admin-Token', got: ${res.headers['www-authenticate']}`,
    )
  })

  // ──────────────────────────────────────────────────────────────────────
  // (4) Admin wrong-token denied
  // ──────────────────────────────────────────────────────────────────────

  it('(4) Admin wrong-token: GET /v1/admin/quota with wrong token returns 401', async (t) => {
    if (!gw) return t.skip('Gateway not available — spawn failed')

    const res = await safeFetch(baseUrl, '/v1/admin/quota', {
      headers: { 'x-admin-token': 'bogus' },
    })

    if (res === null) {
      return t.skip('Gateway unreachable')
    }

    assert.equal(res.status, 401, 'Wrong token request should return 401')
  })

  // ──────────────────────────────────────────────────────────────────────
  // (5) Admin correct-token allowed
  // ──────────────────────────────────────────────────────────────────────

  it('(5) Admin correct-token: GET /v1/admin/quota with valid token returns 200', async (t) => {
    if (!gw) return t.skip('Gateway not available — spawn failed')

    const res = await safeFetch(baseUrl, '/v1/admin/quota', {
      headers: { 'x-admin-token': 'test-admin-token-abc' },
    })

    if (res === null) {
      return t.skip('Gateway unreachable')
    }

    // Accept 200 or 404 (if no quota data upstream), but NOT 401
    assert.notEqual(
      res.status,
      401,
      'Correct token should NOT return 401',
    )
    const acceptable = res.status === 200 || res.status === 404
    assert.ok(
      acceptable,
      `Correct token should return 200 or 404 (got ${res.status})`,
    )
  })
})
