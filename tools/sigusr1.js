/**
 * sigusr1.js — Cross-platform SIGUSR1 sender.
 *
 * Used by rotate-key.ts to signal the gateway process to hot-reload
 * keys without restart. On non-Unix platforms (Windows), falls back
 * to a no-op (the gateway must be restarted manually).
 */

import { spawn } from 'node:child_process'

export function sendSigusr1(pid) {
  if (process.platform === 'win32') {
    // Windows: no SIGUSR1. Caller must restart the gateway.
    return false
  }
  try {
    process.kill(pid, 'SIGUSR1')
    return true
  } catch {
    return false
  }
}
