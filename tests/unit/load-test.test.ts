#!/usr/bin/env tsx
/**
 * load-test.test.ts — Smoke test for the load-test report renderer.
 *
 * Verifies that the report builder produces a markdown table with the
 * expected sections and a numeric table row per scenario. Skips actual
 * load testing since the gateway would have to be running; the report
 * renderer is the only piece of load-test.ts that is pure-function and
 * testable in isolation.
 *
 * Run: cd tests && tsx --test unit/load-test.test.ts
 *
 * (The full load test is exercised by running `pnpm --filter gateway load-test`
 * with the gateway running, ideally inside the docker-compose stack.)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Re-derive the report shape via subprocess (no export) ────────────

function runLoadTestRender(): string {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const result = spawnSync(
    'node_modules/.bin/tsx',
    ['-e', `
      import { renderReport } from './tools/load-test.ts'
      console.log(renderReport([
        { name: 'warm-up', rps: 10, durationMs: 30000, totalRequests: 300, okCount: 300, errorCount: 0, errorsByStatus: {}, latencyMs: { p50: 1.0, p95: 2.5, p99: 3.0, max: 5.0 } },
        { name: 'baseline', rps: 50, durationMs: 60000, totalRequests: 3000, okCount: 2990, errorCount: 10, errorsByStatus: { 429: 10 }, latencyMs: { p50: 5.0, p95: 10.0, p99: 15.0, max: 50.0 } },
      ]))
    `],
    { encoding: 'utf-8', cwd: '.' },
  )
  return result.stdout
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('tools/load-test.ts (report renderer)', () => {
  it('(1) renderer produces a markdown report with summary table', () => {
    const md = runLoadTestRender()
    assert.match(md, /^# Load test report/m)
    assert.match(md, /## Summary/)
    assert.match(md, /\| Scenario \| RPS \| Duration \| Total \| OK \| Errors \|/)
    assert.match(md, /\| warm-up \|/)
    assert.match(md, /\| baseline \|/)
  })

  it('(2) renderer includes per-scenario detail section', () => {
    const md = runLoadTestRender()
    assert.match(md, /## Per-scenario detail/)
    assert.match(md, /### warm-up/)
    assert.match(md, /### baseline/)
    assert.match(md, /- p50: 1.0ms/)
  })

  it('(3) renderer surfaces top error codes when present', () => {
    const md = runLoadTestRender()
    assert.match(md, /- Top error codes:/)
    assert.match(md, /429: 10/)
  })
})
