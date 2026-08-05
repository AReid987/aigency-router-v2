#!/usr/bin/env tsx
/**
 * rotate-key.ts — Versioned API key rotation for provider credentials.
 *
 * Reads auth.json (or GATEWAY_AUTH_PATH env override) and rolls a
 * provider key with a 24-hour overlap window:
 *   - Writes the new key with status=active
 *   - Marks the old key status=deprecated (with deprecatedAt timestamp)
 *   - Sends SIGUSR1 to the running gateway process (from GATEWAY_PID_PATH
 *     or process-group lookup) so the gateway hot-reloads active keys
 *   - `--prune` removes deprecated keys older than 24h
 *
 * Usage:
 *   pnpm --filter gateway rotate-key openai --new-key sk-...
 *   pnpm --filter gateway rotate-key openai --prune
 *   pnpm --filter gateway rotate-key openai --new-key sk-... --gateway-pid 1234
 *
 * Exit code 0 on success; 1 on failure.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sendSigusr1 } from './sigusr1.js'

// ── Types ──────────────────────────────────────────────────────────────

interface KeyRecord {
  type: 'api_key'
  key: string
  status?: 'active' | 'deprecated'
  deprecatedAt?: string
}

interface AuthFile {
  [provider: string]: KeyRecord | KeyRecord[]
}

interface Args {
  provider: string
  newKey: string | null
  prune: boolean
  gatewayPid: number | null
  authPath: string
  graceHours: number
}

const DEFAULT_GRACE_HOURS = 24
const SIGUSR1_SIGNAL = 10

// ── Args ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const out: Args = {
    provider: '',
    newKey: null,
    prune: false,
    gatewayPid: null,
    authPath: process.env.GATEWAY_AUTH_PATH ?? '~/.gsd/agent/auth.json',
    graceHours: Number.parseInt(process.env.GATEWAY_KEY_GRACE_HOURS ?? '', 10) || DEFAULT_GRACE_HOURS,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!out.provider && !a.startsWith('--')) out.provider = a
    else if (a === '--new-key') out.newKey = argv[++i]
    else if (a === '--prune') out.prune = true
    else if (a === '--gateway-pid') out.gatewayPid = parseInt(argv[++i], 10)
    else if (a === '--auth-path') out.authPath = argv[++i]
    else if (a === '--grace-hours') out.graceHours = parseInt(argv[++i], 10)
  }
  return out
}

// ── Logging ──────────────────────────────────────────────────────────

function log(event: string, data: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event,
      ...data,
    }),
  )
}

// ── Auth file operations ────────────────────────────────────────────

function readAuthFile(path: string): AuthFile {
  const resolved = resolve(path.replace(/^~/, process.env.HOME ?? ''))
  if (!existsSync(resolved)) {
    log('KEY_ROTATE_FAILED', { authPath: resolved, reason: 'auth_file_not_found' })
    process.exit(1)
  }
  try {
    return JSON.parse(readFileSync(resolved, 'utf-8')) as AuthFile
  } catch (err) {
    log('KEY_ROTATE_FAILED', { authPath: resolved, reason: 'parse_error', error: (err as Error).message })
    process.exit(1)
  }
}

function writeAuthFile(path: string, data: AuthFile): void {
  const resolved = resolve(path.replace(/^~/, process.env.HOME ?? ''))
  writeFileSync(resolved, JSON.stringify(data, null, 2), 'utf-8')
}

function getActiveKeys(record: KeyRecord | KeyRecord[] | undefined): KeyRecord[] {
  if (!record) return []
  const arr = Array.isArray(record) ? record : [record]
  return arr.filter((k) => k.status === 'active' || k.status === undefined)
}

function getDeprecatedKeys(record: KeyRecord | KeyRecord[] | undefined): KeyRecord[] {
  if (!record) return []
  const arr = Array.isArray(record) ? record : [record]
  return arr.filter((k) => k.status === 'deprecated')
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.provider) {
    log('KEY_ROTATE_FAILED', { reason: 'provider_required' })
    process.exit(1)
  }

  const auth = readAuthFile(args.authPath)
  const current = auth[args.provider] as KeyRecord | KeyRecord[] | undefined
  const activeKeys = getActiveKeys(current)
  const deprecatedKeys = getDeprecatedKeys(current)

  if (args.prune) {
    // Prune deprecated keys older than graceHours
    const cutoffMs = Date.now() - args.graceHours * 60 * 60 * 1000
    const remaining: KeyRecord[] = []
    let pruned = 0
    for (const k of deprecatedKeys) {
      if (k.deprecatedAt && Date.parse(k.deprecatedAt) < cutoffMs) {
        pruned++
      } else {
        remaining.push(k)
      }
    }
    const arr = [...activeKeys, ...remaining]
    if (arr.length > 0) {
      auth[args.provider] = arr
    } else {
      delete auth[args.provider]
    }
    writeAuthFile(args.authPath, auth)
    log('KEY_PRUNED', { provider: args.provider, pruned, remaining: remaining.length })
    return
  }

  if (!args.newKey) {
    log('KEY_ROTATE_FAILED', { reason: 'new_key_required', provider: args.provider })
    process.exit(1)
  }

  // Mark existing active keys as deprecated
  const now = new Date().toISOString()
  const newRecord: KeyRecord[] = [
    { type: 'api_key', key: args.newKey, status: 'active' },
    ...activeKeys.map((k) => ({
      type: 'api_key' as const,
      key: k.key,
      status: 'deprecated' as const,
      deprecatedAt: now,
    })),
    ...deprecatedKeys, // keep existing deprecated for the duration
  ]
  auth[args.provider] = newRecord
  writeAuthFile(args.authPath, auth)

  // Send SIGUSR1 to the gateway so it hot-reloads active keys
  let pid = args.gatewayPid
  if (!pid && process.env.GATEWAY_PID_PATH) {
    try {
      const { readFileSync } = await import('node:fs')
      pid = parseInt(readFileSync(process.env.GATEWAY_PID_PATH, 'utf-8').trim(), 10)
    } catch {
      // ignore
    }
  }

  let signalSent = false
  if (pid && !Number.isNaN(pid)) {
    try {
      sendSigusr1(pid)
      signalSent = true
    } catch {
      // best-effort
    }
  }

  log('KEY_ROTATED', {
    provider: args.provider,
    activeCount: newRecord.filter((k) => k.status === 'active').length,
    deprecatedCount: newRecord.filter((k) => k.status === 'deprecated').length,
    signalSent,
    pid: pid ?? null,
  })
}

main().catch((err) => {
  log('KEY_ROTATE_FAILED', { reason: (err as Error).message })
  process.exit(1)
})
