#!/usr/bin/env tsx
/**
 * spawn-gateway-rate-limit.ts — Spawn the gateway as a subprocess with
 * rate-limit and admin-auth middleware for E2E integration testing.
 *
 * Usage (import):
 *   import { spawnGateway } from './scripts/spawn-gateway-rate-limit.ts'
 *   const gw = await spawnGateway({ GATEWAY_RATE_LIMITING: 'true', ... })
 *   // gw = { baseUrl, port, kill }
 *
 * Usage (standalone):
 *   GATEWAY_PORT=3456 GATEWAY_RATE_LIMITING=true tsx this-file.ts
 *
 * The module auto-detects whether it is being used as an import or
 * running as the main entry point.
 */

import { spawn } from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ── Types ──────────────────────────────────────────────────────────────

export interface GatewayHandle {
  baseUrl: string
  port: number
  kill: () => void
}

// ── Internal helpers ──────────────────────────────────────────────────

/** Get the filesystem path of this module. */
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Resolve the project root (3 levels up from tests/integration/scripts/). */
const projectRoot = path.resolve(__dirname, '../../..')
const tsxBin = path.resolve(projectRoot, 'node_modules/.bin/tsx')

/**
 * Find a free TCP port by binding to port 0 on 127.0.0.1.
 * There is a tiny race between close and spawn, but acceptable for tests.
 */
function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (!addr || typeof addr !== 'object') {
        s.close()
        return reject(new Error('Could not determine server address'))
      }
      const port = addr.port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

/**
 * Poll 127.0.0.1:port until the port is accepting connections.
 * Throws after timeoutMs milliseconds.
 */
function waitForPort(port: number, host: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function poll(): void {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timeout waiting for ${host}:${port}`))
      }
      const sock = new net.Socket()
      sock.on('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.on('error', () => {
        sock.destroy()
        setTimeout(poll, 100)
      })
      sock.connect(port, host)
    }
    poll()
  })
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Spawn a gateway child process with rate-limit + admin-auth middleware.
 *
 * @param envOverrides — Environment variables to set on the child.
 *   Typical values:
 *     GATEWAY_RATE_LIMITING=true
 *     GATEWAY_RATE_LIMIT_TOKENS=100
 *     GATEWAY_RATE_LIMIT_WINDOW_MS=60000
 *     GATEWAY_ADMIN_AUTH=true
 *     GATEWAY_ADMIN_TOKEN=test-admin-token-abc
 * @returns A handle with baseUrl, port, and kill().
 */
export async function spawnGateway(
  envOverrides: Record<string, string> = {},
): Promise<GatewayHandle> {
  const port = await getRandomPort()
  const host = '127.0.0.1'

  const child = spawn(tsxBin, [__filename], {
    cwd: projectRoot,
    env: {
      ...(process.env as Record<string, string>),
      GATEWAY_PORT: String(port),
      GATEWAY_HOST: host,
      ...envOverrides,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  await waitForPort(port, host, 10000)

  return {
    port,
    baseUrl: `http://${host}:${port}`,
    kill: () => {
      child.kill()
    },
  }
}

// ── Standalone server (when run as main / child process) ──────────────

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(__filename)

if (isMain) {
  const port = parseInt(process.env.GATEWAY_PORT ?? '0', 10)
  const host = process.env.GATEWAY_HOST ?? '127.0.0.1'

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    // Collect request body
    const body = await new Promise<string>((resolve) => {
      const buffers: Buffer[] = []
      req.on('data', (chunk: Buffer) => buffers.push(chunk))
      req.on('end', () => resolve(Buffer.concat(buffers).toString('utf-8')))
    })

    // Build flat headers map
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '')
    }

    // ── Rate limiting (gated) — only for /v1/chat/completions ──
    if (
      process.env.GATEWAY_RATE_LIMITING === 'true' &&
      url === '/v1/chat/completions' &&
      method === 'POST'
    ) {
      const { getActiveRateLimiter } = await import(
        '../../../workers/gateway/src/rate-limiter.ts'
      )
      const limiter = getActiveRateLimiter()
      const key = headers['x-api-key'] ?? 'anonymous'
      const result = limiter.consume(key)

      if (!result.allowed) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(
            Math.ceil((result.retryAfterMs ?? 60000) / 1000),
          ),
          'x-ratelimit-remaining': '0',
        })
        res.end(
          JSON.stringify({
            error: {
              message: 'Rate limit exceeded. Try again later.',
              type: 'rate_limit_error',
            },
          }),
        )
        return
      }
    }

    // ── Admin auth (gated) — for any /v1/admin/ path ──────────
    if (url.startsWith('/v1/admin/')) {
      if (process.env.GATEWAY_ADMIN_AUTH === 'true') {
        const adminToken = process.env.GATEWAY_ADMIN_TOKEN

        // Deny all if token is unset
        if (!adminToken) {
          res.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': 'Admin-Token',
          })
          res.end(
            JSON.stringify({
              error: {
                message: 'Admin authentication required',
                type: 'auth_error',
              },
            }),
          )
          return
        }

        const { createAdminAuthMiddleware } = await import(
          '../../../workers/gateway/src/middleware.ts'
        )
        const authMw = createAdminAuthMiddleware({ token: adminToken })
        const mockReq = { headers, url, method }

        if (!authMw(mockReq)) {
          res.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': 'Admin-Token',
          })
          res.end(
            JSON.stringify({
              error: {
                message: 'Admin authentication required',
                type: 'auth_error',
              },
            }),
          )
          return
        }
      }

      // GET /v1/admin/quota
      if (method === 'GET' && url === '/v1/admin/quota') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ providers: [], generated_at: Date.now() }))
        return
      }
    }

    // ── POST /v1/chat/completions (rate-limited or not) ─────
    if (method === 'POST' && url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      )
      return
    }

    // ── Favicon noise ─────────────────────────────────────────
    if (url === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    // ── 404 fallback ─────────────────────────────────────────
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  server.listen(port, host, () => {
    console.error(`[gateway-rate-limit] listening on ${host}:${port}`)
  })

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0))
  })
}
