/**
 * Pino-based JSON structured logger.
 *
 * Produces one JSON line per log entry on stdout, with:
 *   - level  (human-readable)
 *   - time   (ISO-8601)
 *   - service, version, pid (base fields)
 *   - msg    (the actual message)
 *   - any additional fields passed as the second argument
 *
 * Run: cd workers/gateway && tsx --test src/logger.test.ts
 */

import pino from 'pino'

// ── Types ──────────────────────────────────────────────────────────────

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  debug(msg: string, fields?: Record<string, unknown>): void
  fatal(msg: string, fields?: Record<string, unknown>): void
}

export interface LoggerOpts {
  level?: string
  base?: Record<string, unknown>
}

// ── Factory ────────────────────────────────────────────────────────────

export function createLogger(opts: LoggerOpts = {}): Logger {
  const instance = pino({
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: {
      service: 'aigency-gateway',
      version: process.env.npm_package_version ?? '0.0.0',
      pid: process.pid,
      ...opts.base,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label }
      },
    },
  })

  return {
    info(msg: string, fields?: Record<string, unknown>) {
      instance.info(fields ?? {}, msg)
    },
    warn(msg: string, fields?: Record<string, unknown>) {
      instance.warn(fields ?? {}, msg)
    },
    error(msg: string, fields?: Record<string, unknown>) {
      instance.error(fields ?? {}, msg)
    },
    debug(msg: string, fields?: Record<string, unknown>) {
      instance.debug(fields ?? {}, msg)
    },
    fatal(msg: string, fields?: Record<string, unknown>) {
      instance.fatal(fields ?? {}, msg)
    },
  }
}

export default createLogger
