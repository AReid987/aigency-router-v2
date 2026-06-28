#!/usr/bin/env tsx
/**
 * backup.test.ts — Unit tests for tools/backup.ts.
 *
 * Run: cd tests && tsx --test unit/backup.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Helpers ────────────────────────────────────────────────────────────

function makeTestDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gsd-backup-test-'))
  const dbPath = join(dir, 'usage.db')
  spawnSync('sqlite3', [dbPath, 'CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT)'])
  spawnSync('sqlite3', [dbPath, "INSERT INTO events (ts) VALUES ('2026-06-27T00:00:00Z'),('2026-06-27T01:00:00Z')"])
  return dbPath
}

function runBackup(args: string[], env: Record<string, string> = {}): { code: number; stdout: string } {
  const tsxBin = 'node_modules/.bin/tsx'
  const result = spawnSync(tsxBin, ['tools/backup.ts', ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  })
  return { code: result.status ?? -1, stdout: result.stdout }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('tools/backup.ts', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gsd-backup-out-'))
  })
  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('(1) source db not found → exit 1 + BACKUP_FAILED log', () => {
    const fakeDb = join(tempDir, 'does-not-exist.db')
    const r = runBackup(['--db', fakeDb, '--dir', tempDir])
    assert.equal(r.code, 1)
    const lines = r.stdout.split('\n').filter(Boolean).map((s) => JSON.parse(s))
    const failed = lines.find((l) => l.event === 'BACKUP_FAILED')
    assert.ok(failed, 'expected BACKUP_FAILED log line')
    assert.equal(failed.source, fakeDb)
    assert.equal(failed.reason, 'source_db_not_found')
  })

  it('(2) successful backup → exit 0 + BACKUP_OK log + .db file present', () => {
    const dbPath = makeTestDb()
    const r = runBackup(['--db', dbPath, '--dir', tempDir])
    assert.equal(r.code, 0)
    const lines = r.stdout.split('\n').filter(Boolean).map((s) => JSON.parse(s))
    const ok = lines.find((l) => l.event === 'BACKUP_OK')
    assert.ok(ok, 'expected BACKUP_OK log line')
    assert.equal(ok.source, dbPath)
    assert.ok(ok.bytesWritten > 0)
    assert.match(ok.destination, /usage-\d{4}-\d{2}-\d{2}\.db$/)
    assert.ok(existsSync(ok.destination), 'expected destination file to exist')
  })

  it('(3) idempotency: second run same day → exit 0 + BACKUP_SKIPPED log', () => {
    const dbPath = makeTestDb()
    const r1 = runBackup(['--db', dbPath, '--dir', tempDir])
    assert.equal(r1.code, 0)
    const r2 = runBackup(['--db', dbPath, '--dir', tempDir])
    assert.equal(r2.code, 0)
    const lines = r2.stdout.split('\n').filter(Boolean).map((s) => JSON.parse(s))
    const skipped = lines.find((l) => l.event === 'BACKUP_SKIPPED')
    assert.ok(skipped, 'expected BACKUP_SKIPPED log line')
    assert.equal(skipped.reason, 'already_exists')
  })

  it('(4) dry-run → exit 0 + no file written + BACKUP_DRY_RUN log', () => {
    const dbPath = makeTestDb()
    const r = runBackup(['--db', dbPath, '--dir', tempDir, '--dry-run'])
    assert.equal(r.code, 0)
    const lines = r.stdout.split('\n').filter(Boolean).map((s) => JSON.parse(s))
    const dry = lines.find((l) => l.event === 'BACKUP_DRY_RUN')
    assert.ok(dry, 'expected BACKUP_DRY_RUN log line')
    // No file written
    const destMatch = dry.destination.match(/usage-(\d{4}-\d{2}-\d{2})\.db$/)
    assert.ok(destMatch, 'destination should match expected pattern')
    const expected = join(tempDir, destMatch[0])
    assert.equal(existsSync(expected), false)
  })

  it('(5) auto-creates the destination directory if missing', () => {
    const dbPath = makeTestDb()
    const nestedDir = join(tempDir, 'subdir', 'nested')
    const r = runBackup(['--db', dbPath, '--dir', nestedDir])
    assert.equal(r.code, 0)
    assert.ok(existsSync(nestedDir))
  })
})
