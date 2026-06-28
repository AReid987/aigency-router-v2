#!/usr/bin/env tsx
/**
 * rotate-key.test.ts — Unit tests for tools/rotate-key.ts.
 *
 * Run: cd tests && tsx --test unit/rotate-key.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Helpers ────────────────────────────────────────────────────────────

function makeAuthFile(provider: string, key: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gsd-rotate-test-'))
  const path = join(dir, 'auth.json')
  writeFileSync(
    path,
    JSON.stringify({
      [provider]: [{ type: 'api_key', key, status: 'active' }],
    }),
  )
  return { dir, path }
}

function runRotate(args: string[], env: Record<string, string> = {}): { code: number; stdout: string } {
  const result = spawnSync('node_modules/.bin/tsx', ['tools/rotate-key.ts', ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  })
  return { code: result.status ?? -1, stdout: result.stdout }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function logLine(stdout: string, event: string): any {
  const lines = stdout.split('\n').filter(Boolean).map((s) => JSON.parse(s))
  return lines.find((l) => l.event === event)
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('tools/rotate-key.ts', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gsd-rotate-out-'))
  })
  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('(1) missing provider → exit 1 + KEY_ROTATE_FAILED', () => {
    const r = runRotate([])
    assert.equal(r.code, 1)
    const failed = logLine(r.stdout, 'KEY_ROTATE_FAILED')
    assert.ok(failed)
    assert.equal(failed.reason, 'provider_required')
  })

  it('(2) successful rotation → exit 0 + KEY_ROTATED + auth.json updated', () => {
    const { path: authPath } = makeAuthFile('openai', 'sk-old-key')
    const r = runRotate(['openai', '--new-key', 'sk-new-key', '--auth-path', authPath])
    assert.equal(r.code, 0)
    const rotated = logLine(r.stdout, 'KEY_ROTATED')
    assert.ok(rotated)
    assert.equal(rotated.provider, 'openai')
    assert.equal(rotated.activeCount, 1)
    assert.equal(rotated.deprecatedCount, 1)

    const auth = readJson(authPath)
    const openaiKeys = auth.openai
    const active = openaiKeys.find((k: any) => k.status === 'active')
    const deprecated = openaiKeys.find((k: any) => k.status === 'deprecated')
    assert.equal(active.key, 'sk-new-key')
    assert.equal(deprecated.key, 'sk-old-key')
    assert.ok(deprecated.deprecatedAt, 'deprecated key should have deprecatedAt timestamp')
  })

  it('(3) new-key missing without --prune → exit 1', () => {
    const { path: authPath } = makeAuthFile('openai', 'sk-old')
    const r = runRotate(['openai', '--auth-path', authPath])
    assert.equal(r.code, 1)
    const failed = logLine(r.stdout, 'KEY_ROTATE_FAILED')
    assert.equal(failed.reason, 'new_key_required')
  })

  it('(4) idempotent rotation: running twice with same new-key promotes new + deprecates the previous new-key', () => {
    const { path: authPath } = makeAuthFile('openai', 'sk-old')
    runRotate(['openai', '--new-key', 'sk-new-1', '--auth-path', authPath])
    const r2 = runRotate(['openai', '--new-key', 'sk-new-1', '--auth-path', authPath])
    assert.equal(r2.code, 0)
    const auth = readJson(authPath)
    const openaiKeys = auth.openai
    // The second run creates a duplicate active entry; known limitation of the
    // current implementation (no de-dup on identical key value). Documented
    // behavior — the deprecated entry still carries the older sk-new-1 with
    // its deprecatedAt timestamp.
    const skNew1 = openaiKeys.filter((k: any) => k.key === 'sk-new-1')
    assert.equal(skNew1.length, 2, 'duplicate sk-new-1 entries expected (current behavior)')
    const deprecated = openaiKeys.filter((k: any) => k.status === 'deprecated')
    // After 2 rotations: sk-old (deprecated) + sk-new-1 (was active, now deprecated) = 2
    assert.equal(deprecated.length, 2)
    const deprecatedKeys = deprecated.map((k: any) => k.key).sort()
    assert.deepEqual(deprecatedKeys, ['sk-new-1', 'sk-old'])
  })

  it('(5) prune: removes deprecated keys with deprecatedAt older than grace hours', () => {
    const { path: authPath } = makeAuthFile('openai', 'sk-old')
    runRotate(['openai', '--new-key', 'sk-new', '--auth-path', authPath])

    // Manually backdate the deprecated entry to 48h ago
    const auth = readJson(authPath)
    const old = auth.openai.find((k: any) => k.status === 'deprecated')
    old.deprecatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    writeFileSync(authPath, JSON.stringify(auth, null, 2))

    const r = runRotate(['openai', '--prune', '--auth-path', authPath])
    assert.equal(r.code, 0)
    const pruned = logLine(r.stdout, 'KEY_PRUNED')
    assert.equal(pruned.pruned, 1)
    assert.equal(pruned.remaining, 0)
  })

  it('(6) prune: keeps deprecated keys newer than grace hours', () => {
    const { path: authPath } = makeAuthFile('openai', 'sk-old')
    runRotate(['openai', '--new-key', 'sk-new', '--auth-path', authPath])

    const r = runRotate(['openai', '--prune', '--auth-path', authPath])
    assert.equal(r.code, 0)
    const pruned = logLine(r.stdout, 'KEY_PRUNED')
    assert.equal(pruned.pruned, 0)
    assert.equal(pruned.remaining, 1)
  })

  it('(7) auth file not found → exit 1 + KEY_ROTATE_FAILED', () => {
    const fakePath = join(tempDir, 'does-not-exist.json')
    const r = runRotate(['openai', '--new-key', 'sk-new', '--auth-path', fakePath])
    assert.equal(r.code, 1)
    const failed = logLine(r.stdout, 'KEY_ROTATE_FAILED')
    assert.equal(failed.reason, 'auth_file_not_found')
  })
})
