/**
 * Health Router — liveness and readiness endpoints for K8s/Docker probes.
 *
 * GET /health — lightweight liveness check (< 50ms, no external deps).
 * GET /ready  — readiness check that probes vault and sugar-db dependencies.
 *
 * Run: cd workers/gateway && tsx --test src/health.test.ts
 */

import type http from 'node:http'

// ── Types ──────────────────────────────────────────────────────────────

export interface HealthRouterDeps {
  vaultUrl?: string
  sugarDbUrl?: string
  /** HEAD request timeout per dependency (ms). Default: 2000. */
  timeout?: number
  /** Optional telemetry emitter. Pass null or omit to disable. */
  telemetry?: { emit: (eventClass: string) => void } | null
}

export interface HealthRouter {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void
}

// ── Helpers ────────────────────────────────────────────────────────────

async function checkUrl(url: string, timeoutMs: number): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await globalThis.fetch(url, { method: 'HEAD', signal: controller.signal })
    clearTimeout(timer)
    return { ok: response.ok, latencyMs: Date.now() - start }
  } catch {
    return { ok: false, latencyMs: Date.now() - start }
  }
}

function writeJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const raw = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(raw)
}

// ── Factory ────────────────────────────────────────────────────────────

export function createHealthRouter(deps: HealthRouterDeps = {}): HealthRouter {
  const vaultUrl = deps.vaultUrl ?? process.env.GATEWAY_VAULT_URL ?? 'http://127.0.0.1:8082'
  const sugarDbUrl = deps.sugarDbUrl ?? process.env.GATEWAY_SUGAR_DB_URL ?? 'http://127.0.0.1:8081'
  const timeout = deps.timeout ?? 2000

  return {
    handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
      // Parse the URL path — avoid depending on req.url directly for query-param noise
      let pathname = '/'
      try {
        pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`).pathname
      } catch {
        pathname = '/'
      }

      // ── GET /health (liveness) ─────────────────────────────────────
      if (req.method === 'GET' && pathname === '/health') {
        writeJson(res, 200, {
          status: 'ok',
          uptimeMs: Math.floor(process.uptime() * 1000),
          version: process.env.npm_package_version ?? '0.0.0',
        })
        if (deps.telemetry) deps.telemetry.emit('HEALTH_CHECK_OK')
        return
      }

      // ── GET /ready (readiness) ──────────────────────────────────────
      if (req.method === 'GET' && pathname === '/ready') {
        // Fire-and-forget the async check — write response when both resolve
        Promise.all([checkUrl(vaultUrl, timeout), checkUrl(sugarDbUrl, timeout)])
          .then(([vault, sugarDb]) => {
            const allOk = vault.ok && sugarDb.ok
            writeJson(res, allOk ? 200 : 503, {
              status: allOk ? 'ready' : 'degraded',
              checks: { vault, sugarDb },
            })
            if (!allOk && deps.telemetry) deps.telemetry.emit('HEALTH_CHECK_FAIL')
          })
          .catch(() => {
            writeJson(res, 503, {
              status: 'degraded',
              checks: { vault: { ok: false, latencyMs: timeout }, sugarDb: { ok: false, latencyMs: timeout } },
            })
          })
        return
      }

      // Not a health route — let caller handle it
      writeJson(res, 404, { error: 'not_found' })
    },
  }
}

export default createHealthRouter
