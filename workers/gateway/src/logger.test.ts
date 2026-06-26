/**
 * logger.test.ts — Unit tests for the pino-based JSON logger.
 *
 * Run: cd workers/gateway && tsx --test src/logger.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Tests ──────────────────────────────────────────────────────────────

describe('createLogger', () => {
  // ── 1. logger.info emits a single JSON line with required fields ─

  it('(1) logger.info emits a single JSON line on stdout with required fields', async () => {
    const { createLogger } = await import('./logger.ts')

    const lines: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)

    // Capture pino output from stdout
    process.stdout.write = ((chunk: string | Uint8Array, ...args: any[]) => {
      const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      lines.push(...str.split('\n').filter(Boolean))
      return true
    }) as typeof process.stdout.write

    try {
      const log = createLogger({ level: 'info' })
      log.info('hello world', { requestId: 'abc-123' })

      // Pino flushes synchronously in Node.js by default (no buffering for info level on stdout)
      process.stdout.write = origWrite

      // Should have at least one line
      assert.ok(lines.length >= 1, 'should emit at least one JSON line')

      // Parse the first line
      const parsed = JSON.parse(lines[0])

      assert.equal(typeof parsed.level, 'string', 'level should be a string')
      assert.equal(parsed.level, 'info', 'level should be "info"')
      assert.equal(typeof parsed.time, 'string', 'time should be an ISO string')
      assert.ok(parsed.time.includes('T'), 'time should be ISO-8601 format')
      assert.equal(parsed.msg, 'hello world', 'msg should match')
      assert.equal(parsed.service, 'aigency-gateway', 'service should be aigency-gateway')
      assert.equal(parsed.requestId, 'abc-123', 'fields should be included')
      assert.equal(typeof parsed.pid, 'number', 'pid should be a number')
    } finally {
      process.stdout.write = origWrite
    }
  })

  // ── 2. logger fields object is included in JSON output ──────────

  it('(2) logger fields object is included in JSON output', async () => {
    const { createLogger } = await import('./logger.ts')

    const lines: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)

    process.stdout.write = ((chunk: string | Uint8Array, ...args: any[]) => {
      const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      lines.push(...str.split('\n').filter(Boolean))
      return true
    }) as typeof process.stdout.write

    try {
      const log = createLogger({ level: 'info' })
      log.warn('something is off', { retryCount: 3, provider: 'groq' })

      process.stdout.write = origWrite

      assert.ok(lines.length >= 1)
      const parsed = JSON.parse(lines[0])

      assert.equal(parsed.level, 'warn')
      assert.equal(parsed.msg, 'something is off')
      assert.equal(parsed.retryCount, 3)
      assert.equal(parsed.provider, 'groq')
    } finally {
      process.stdout.write = origWrite
    }
  })
})
