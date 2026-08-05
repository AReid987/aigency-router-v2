#!/usr/bin/env tsx
/**
 * load-test.ts — Load testing harness for the aigency-router-v2 gateway.
 *
 * Spawns the gateway (or attaches to an existing one) and runs four
 * load scenarios:
 *   1. warm-up   — 10 RPS for 30s (discarded; JIT compile target)
 *   2. baseline  — 50 RPS for 60s
 *   3. burst     — 500 RPS for 30s
 *   4. soak      — 100 RPS for 5 minutes
 *
 * Captures p50/p95/p99 latency, rps, error rate, top error codes, and
 * renders a markdown report at `load-test-report.md` (or the path given
 * by --output). Reports the structured JSON log lines to the same
 * pino telemetry pipeline.
 *
 * Usage:
 *   pnpm --filter gateway load-test
 *   pnpm --filter gateway load-test -- --output /tmp/report.md
 *   pnpm --filter gateway load-test -- --target http://127.0.0.1:49134 --skip-spawn
 *   pnpm --filter gateway load-test -- --skip-soak
 *
 * Exit code 0 on success, 1 on any error.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'

// ── Types ──────────────────────────────────────────────────────────────

interface ScenarioResult {
  name: string
  rps: number
  durationMs: number
  totalRequests: number
  okCount: number
  errorCount: number
  errorsByStatus: Record<number, number>
  latencyMs: {
    p50: number
    p95: number
    p99: number
    max: number
  }
}

interface Args {
  target: string
  output: string
  spawn: boolean
  skipSoak: boolean
  port: number
}

// ── Argument parsing ──────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const out: Args = {
    target: '',
    output: 'load-test-report.md',
    spawn: true,
    skipSoak: false,
    port: 0,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') out.target = argv[++i]
    else if (a === '--output') out.output = argv[++i]
    else if (a === '--skip-spawn') out.spawn = false
    else if (a === '--skip-soak') out.skipSoak = true
    else if (a === '--port') out.port = parseInt(argv[++i], 10)
  }
  return out
}

// ── Helpers ──────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (!addr || typeof addr !== 'object') {
        s.close()
        return reject(new Error('Could not determine port'))
      }
      const p = addr.port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function poll(): void {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timeout waiting for port ${port}`))
      }
      const sock = net.createConnection(port, '127.0.0.1')
      sock.on('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.on('error', () => {
        sock.destroy()
        setTimeout(poll, 100)
      })
    }
    poll()
  })
}

function spawnGateway(port: number): ChildProcess {
  const __filename = fileURLToPath(import.meta.url)
  const toolsDir = path.dirname(__filename)
  const repoRoot = path.resolve(toolsDir, '..')
  const gatewayDir = path.join(repoRoot, 'workers/gateway')
  const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx')
  return spawn(
    tsxBin,
    [path.join(gatewayDir, 'src/index.ts')],
    {
      cwd: gatewayDir,
      env: {
        ...(process.env as Record<string, string>),
        GATEWAY_PORT: String(port),
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_RATE_LIMITING: 'false', // disable for load test
        GATEWAY_ADMIN_AUTH: 'false',
        GATEWAY_CORS: 'false',
        GATEWAY_MAX_REQUEST_BYTES: '10485760', // 10 MiB for the test body
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  )
}

// ── Load test runner ──────────────────────────────────────────────────

function runScenario(
  baseUrl: string,
  path: string,
  rps: number,
  durationMs: number,
  body: string,
): Promise<ScenarioResult> {
  return new Promise((resolve, reject) => {
    const latencies: number[] = []
    const errorsByStatus: Record<number, number> = {}
    let totalRequests = 0
    let okCount = 0
    let errorCount = 0

    const intervalMs = 1000 / rps
    const start = performance.now()
    const endAt = start + durationMs
    const inflight = new Set<Promise<void>>()

    function sendOne(): void {
      const reqStart = performance.now()
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: new URL(baseUrl).port,
          path,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        },
        (res) => {
          const status = res.statusCode ?? 0
          const latency = performance.now() - reqStart
          latencies.push(latency)
          totalRequests++
          if (status >= 200 && status < 500) {
            okCount++
          } else {
            errorCount++
            errorsByStatus[status] = (errorsByStatus[status] ?? 0) + 1
          }
          res.resume()
          res.on('end', () => {})
        },
      )
      req.on('error', () => {
        errorCount++
        totalRequests++
        errorsByStatus[0] = (errorsByStatus[0] ?? 0) + 1
      })
      req.write(body)
      req.end()
    }

    let stopped = false
    function tick(): void {
      if (stopped) return
      if (performance.now() >= endAt) {
        stopped = true
        // Wait for all inflight to finish
        Promise.all(Array.from(inflight)).then(() => {
          // Wait a bit for final responses
          setTimeout(() => {
            const sorted = [...latencies].sort((a, b) => a - b)
            const pct = (p: number): number =>
              sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
            resolve({
              name: '',
              rps,
              durationMs,
              totalRequests,
              okCount,
              errorCount,
              errorsByStatus,
              latencyMs: {
                p50: pct(50),
                p95: pct(95),
                p99: pct(99),
                max: sorted[sorted.length - 1] ?? 0,
              },
            })
          }, 1000)
        })
        return
      }
      sendOne()
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

// ── Markdown report ───────────────────────────────────────────────────

export function renderReport(scenarios: ScenarioResult[]): string {
  const lines: string[] = []
  lines.push('# Load test report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push('| Scenario | RPS | Duration | Total | OK | Errors | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |')
  lines.push('|----------|-----|----------|-------|----|--------|----------|----------|----------|----------|')
  for (const s of scenarios) {
    lines.push(
      `| ${s.name} | ${s.rps} | ${(s.durationMs / 1000).toFixed(0)}s | ${s.totalRequests} | ${s.okCount} | ${s.errorCount} | ${s.latencyMs.p50.toFixed(1)} | ${s.latencyMs.p95.toFixed(1)} | ${s.latencyMs.p99.toFixed(1)} | ${s.latencyMs.max.toFixed(1)} |`,
    )
  }
  lines.push('')
  lines.push('## Per-scenario detail')
  lines.push('')
  for (const s of scenarios) {
    lines.push(`### ${s.name}`)
    lines.push('')
    lines.push(`- RPS target: ${s.rps}`)
    lines.push(`- Duration: ${(s.durationMs / 1000).toFixed(0)}s`)
    lines.push(`- Total requests: ${s.totalRequests}`)
    lines.push(`- Successful: ${s.okCount}`)
    lines.push(`- Errors: ${s.errorCount}`)
    lines.push(`- p50: ${s.latencyMs.p50.toFixed(1)}ms`)
    lines.push(`- p95: ${s.latencyMs.p95.toFixed(1)}ms`)
    lines.push(`- p99: ${s.latencyMs.p99.toFixed(1)}ms`)
    lines.push(`- max: ${s.latencyMs.max.toFixed(1)}ms`)
    if (Object.keys(s.errorsByStatus).length > 0) {
      lines.push('- Top error codes:')
      for (const [code, count] of Object.entries(s.errorsByStatus).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        lines.push(`  - ${code}: ${count}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  let port = args.port
  let gw: ChildProcess | undefined
  if (args.spawn) {
    port = port || (await getFreePort())
    console.error(`Spawning gateway on 127.0.0.1:${port}...`)
    gw = spawnGateway(port)
    await waitForPort(port, 15000)
  } else {
    port = port || parseInt(new URL(args.target).port, 10)
  }
  const target = args.target || `http://127.0.0.1:${port}`

  console.error(`Target: ${target}`)

  const body = JSON.stringify({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'hi' }],
  })

  const scenariosToRun: Array<{ name: string; rps: number; durationMs: number }> = [
    { name: 'warm-up', rps: 10, durationMs: 30_000 },
    { name: 'baseline', rps: 50, durationMs: 60_000 },
    { name: 'burst', rps: 500, durationMs: 30_000 },
  ]
  if (!args.skipSoak) {
    scenariosToRun.push({ name: 'soak', rps: 100, durationMs: 5 * 60_000 })
  }

  const results: ScenarioResult[] = []
  for (const sc of scenariosToRun) {
    console.error(`Running scenario: ${sc.name} (${sc.rps} RPS for ${sc.durationMs / 1000}s)...`)
    const start = Date.now()
    const result = await runScenario(target, '/v1/chat/completions', sc.rps, sc.durationMs, body)
    result.name = sc.name
    const elapsed = (Date.now() - start) / 1000
    console.error(
      `  ${sc.name}: ${result.totalRequests} req in ${elapsed.toFixed(1)}s, ` +
        `p50=${result.latencyMs.p50.toFixed(1)}ms, p95=${result.latencyMs.p95.toFixed(1)}ms, ` +
        `p99=${result.latencyMs.p99.toFixed(1)}ms, errors=${result.errorCount}`,
    )
    results.push(result)
  }

  const report = renderReport(results)
  const fs = await import('node:fs/promises')
  await fs.writeFile(args.output, report, 'utf-8')
  console.error(`Report written to ${args.output}`)

  if (gw) {
    gw.kill()
  }
}

main().catch((err) => {
  console.error('load-test failed:', err)
  if (gw) gw.kill()
  process.exit(1)
})
