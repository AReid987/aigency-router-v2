#!/usr/bin/env tsx
/**
 * test-cors-and-size-limit.ts — E2E integration test for the CORS and
 * request-size-limit middleware.
 *
 * Spawns the real gateway subprocess with both gates enabled and exercises
 * the full request path over the loopback interface.
 *
 * Cases:
 *   1. Preflight from allowed origin → 204 + CORS headers
 *   2. Preflight from disallowed origin → 204 with no CORS headers
 *   3. /v1/chat/completions with body > GATEWAY_MAX_REQUEST_BYTES → 413
 *   4. /v1/admin/dashboard with Origin → CORS allowed
 *   5. Default-off mode → byte-identical to M019/M020 baseline
 *
 * Run: cd tests/integration && tsx --test test-cors-and-size-limit.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawnGateway, type GatewayHandle } from './scripts/spawn-gateway-rate-limit.ts'

// ── Helpers ────────────────────────────────────────────────────────────

function makeRequest(opts: {
  hostname: string
  port: number
  path: string
  method: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        )
      },
    )
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

function streamBody(hostname: string, port: number, path: string, bodySize: number, contentType: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          hostname,
          port,
          path,
          method: 'POST',
          headers: {
            'content-type': contentType,
            'content-length': String(bodySize),
          },
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
          )
        },
      )
      req.on('error', reject)
      req.write(Buffer.alloc(bodySize, 'a'))
      req.end()
    },
  )
}

// ── Test Suite: Both Gates Enabled ───────────────────────────────────

describe('CORS + size-limit middleware (gates ON)', () => {
  let gw: GatewayHandle
  before(async () => {
    gw = await spawnGateway({
      GATEWAY_CORS: 'true',
      GATEWAY_CORS_ALLOWED_ORIGINS: 'https://app.example.com,https://demo.example.com',
      GATEWAY_CORS_ALLOWED_METHODS: 'GET,POST',
      GATEWAY_CORS_ALLOWED_HEADERS: 'Content-Type,Authorization,x-api-key,x-admin-token',
      GATEWAY_CORS_MAX_AGE: '60',
      GATEWAY_MAX_REQUEST_BYTES: '1024',
    })
  })
  after(() => gw.kill())

  // ── 1. Preflight from allowed origin → 204 + CORS headers ──────
  it('(1) preflight from allowed origin returns 204 with CORS headers', async () => {
    const r = await makeRequest({
      hostname: '127.0.0.1',
      port: gw.port,
      path: '/v1/chat/completions',
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    assert.equal(r.status, 204)
    assert.equal(r.headers['access-control-allow-origin'], 'https://app.example.com')
    assert.equal(r.headers['access-control-allow-methods'], 'GET, POST')
    assert.match(String(r.headers['access-control-allow-headers'] ?? ''), /content-type/)
    assert.equal(r.headers['access-control-max-age'], '60')
  })

  // ── 2. Preflight from disallowed origin → 204 with no CORS headers ─
  it('(2) preflight from disallowed origin returns 204 with no CORS headers', async () => {
    const r = await makeRequest({
      hostname: '127.0.0.1',
      port: gw.port,
      path: '/v1/chat/completions',
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'POST',
      },
    })
    assert.equal(r.status, 204)
    assert.equal(r.headers['access-control-allow-origin'], undefined)
  })

  // ── 3. Oversized Content-Length body → 413 ──────────────────────
  it('(3) oversized Content-Length body returns 413 + JSON', async () => {
    const r = await streamBody(
      '127.0.0.1',
      gw.port,
      '/v1/chat/completions',
      2048,
      'application/json',
    )
    assert.equal(r.status, 413)
    assert.match(r.body, /"error":"request_too_large"/)
    assert.match(r.body, /"maxBytes":1024/)
  })

  // ── 4. /v1/admin/dashboard with Origin → CORS allowed (and 401 without admin token) ─
  it('(4) /v1/admin/dashboard with Origin returns 401 + CORS headers', async () => {
    const r = await makeRequest({
      hostname: '127.0.0.1',
      port: gw.port,
      path: '/v1/admin/dashboard',
      method: 'GET',
      headers: { origin: 'https://app.example.com' },
    })
    // Without admin token and without GATEWAY_ADMIN_AUTH, this returns 401 because
    // admin routes require auth; CORS allowed-origin headers should still be set.
    assert.equal(r.status, 401)
    assert.equal(r.headers['access-control-allow-origin'], 'https://app.example.com')
  })
})

// ── Test Suite: Default-Off Mode ────────────────────────────────────

describe('CORS + size-limit middleware (default OFF)', () => {
  let gw: GatewayHandle
  before(async () => {
    // Note: GATEWAY_CORS unset, GATEWAY_MAX_REQUEST_BYTES unset
    gw = await spawnGateway({})
  })
  after(() => gw.kill())

  // ── 5. Default-off: behavior byte-identical to M019/M020 baseline ─
  it('(5) default-off: no CORS headers added; multi-MiB body accepted', async () => {
    const r1 = await makeRequest({
      hostname: '127.0.0.1',
      port: gw.port,
      path: '/v1/chat/completions',
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
      },
    })
    assert.equal(r1.status, 404) // gateway has no /v1/chat/completions OPTIONS route
    assert.equal(r1.headers['access-control-allow-origin'], undefined)

    // Body of 5 MiB (under the M019 threshold if it existed) is accepted — no 413
    const r2 = await streamBody(
      '127.0.0.1',
      gw.port,
      '/v1/chat/completions',
      5 * 1024 * 1024,
      'application/json',
    )
    // Default-off means size-limit is a noop; gateway should NOT 413
    assert.notEqual(r2.status, 413)
  })
})
