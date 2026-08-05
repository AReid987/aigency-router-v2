/**
 * Graceful Shutdown — clean drain on SIGTERM / SIGINT.
 *
 * Registers signal handlers that:
 *   1. Log the shutdown signal
 *   2. Call server.close() to stop accepting new connections
 *   3. Race against a 30 s timeout
 *   4. process.exit(0) on clean drain, process.exit(1) on timeout
 *   5. Returns an unregister function for tests.
 *
 * Run: cd workers/gateway && tsx --test src/lifecycle.test.ts
 */

import type http from 'node:http'

// ── Types ──────────────────────────────────────────────────────────────

export interface LifecycleDeps {
  logger: {
    info: (msg: string, fields?: Record<string, unknown>) => void
    error: (msg: string, fields?: Record<string, unknown>) => void
  }
}

export interface GracefulShutdown {
  /** Deregister the signal handlers. */
  unregister(): void
}

// ── Default logger (no-op if none injected — used as safety net) ───────

const noopLogger = { info: () => {}, error: () => {} }

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Register SIGTERM and SIGINT handlers that gracefully drain the server.
 *
 * @param server - Node.js http.Server to close
 * @param deps   - Injected logger
 * @returns      { unregister } — call to remove the signal handlers
 */
export function createGracefulShutdown(server: http.Server, deps?: LifecycleDeps): GracefulShutdown {
  const log = deps?.logger ?? noopLogger
  const DRAIN_TIMEOUT_MS = 30_000

  let shuttingDown = false

  function handleSignal(signal: string) {
    if (shuttingDown) return // Prevent double-drain
    shuttingDown = true

    log.info('shutdown signal received, draining...', { signal })

    // Race server.close() against a timeout
    const closePromise = new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) {
          log.error('server close error', { error: err.message })
        }
        resolve()
      })
    })

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('drain timeout')), DRAIN_TIMEOUT_MS).unref()
    })

    Promise.race([closePromise, timeoutPromise])
      .then(() => {
        log.info('server drained successfully', { signal })
        process.exit(0)
      })
      .catch((err: Error) => {
        log.error('shutdown timeout exceeded, forcing exit', { error: err.message })
        process.exit(1)
      })
  }

  process.on('SIGTERM', handleSignal)
  process.on('SIGINT', handleSignal)

  return {
    unregister() {
      process.off('SIGTERM', handleSignal)
      process.off('SIGINT', handleSignal)
    },
  }
}

export default createGracefulShutdown
