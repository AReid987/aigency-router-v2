#!/usr/bin/env tsx
/**
 * backup.ts — Idempotent backup of the gateway's usage.db.
 *
 * Reads GATEWAY_ZERO_COST_DB_PATH (default `./data/usage.db`) and
 * GATEWAY_BACKUP_DIR (default `./backups`). Calls `sqlite3 .backup`
 * with a timestamped destination. Existing-timestamp destinations are
 * skipped (BACKUP_SKIPPED log, exit 0).
 *
 * Usage:
 *   pnpm --filter gateway backup:run
 *   pnpm --filter gateway backup:run -- --db /var/lib/aigency/usage.db --dir /var/backups
 *   pnpm --filter gateway backup:run -- --dry-run
 *
 * Exit code 0 on success or idempotent skip; 1 on failure.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Args ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  db: string
  dir: string
  dryRun: boolean
} {
  const out = {
    db: process.env.GATEWAY_ZERO_COST_DB_PATH ?? './data/usage.db',
    dir: process.env.GATEWAY_BACKUP_DIR ?? './backups',
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i]
    else if (a === '--dir') out.dir = argv[++i]
    else if (a === '--dry-run') out.dryRun = true
  }
  return out
}

// ── Logging ──────────────────────────────────────────────────────────

function log(event: string, data: Record<string, unknown>): void {
  // Structured JSON log line so it composes with the pino telemetry stream.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event,
      ...data,
    }),
  )
}

// ── sqlite .backup runner ────────────────────────────────────────────

function runSqliteBackup(dbPath: string, destPath: string): Promise<{ durationMs: number; bytesWritten: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const child = spawn('sqlite3', [dbPath, `.backup '${destPath}'`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) {
        const { statSync } = require('node:fs') as typeof import('node:fs')
        const stat = statSync(destPath)
        resolve({ durationMs: Date.now() - start, bytesWritten: stat.size })
      } else {
        reject(new Error(`sqlite3 exited with code ${code}: ${stderr}`))
      }
    })
  })
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = resolve(args.db)
  const dir = resolve(args.dir)
  const stamp = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const destPath = resolve(dir, `usage-${stamp}.db`)

  if (!existsSync(dbPath)) {
    log('BACKUP_FAILED', { source: dbPath, reason: 'source_db_not_found' })
    process.exit(1)
  }

  // Idempotency: skip if today's backup already exists
  if (existsSync(destPath)) {
    log('BACKUP_SKIPPED', { source: dbPath, destination: destPath, reason: 'already_exists' })
    process.exit(0)
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (args.dryRun) {
    log('BACKUP_DRY_RUN', { source: dbPath, destination: destPath })
    process.exit(0)
  }

  try {
    const { durationMs, bytesWritten } = await runSqliteBackup(dbPath, destPath)
    log('BACKUP_OK', {
      source: dbPath,
      destination: destPath,
      bytesWritten,
      durationMs,
    })
    process.exit(0)
  } catch (err) {
    log('BACKUP_FAILED', {
      source: dbPath,
      destination: destPath,
      reason: (err as Error).message,
    })
    process.exit(1)
  }
}

main().catch((err) => {
  log('BACKUP_FAILED', { reason: (err as Error).message })
  process.exit(1)
})
