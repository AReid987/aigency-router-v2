import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// ── Types ──────────────────────────────────────────────────────────────

export interface LogEventInput {
  event_class: string
  source_worker: string
  payload_snapshot: unknown
}

export interface QueryEventsInput {
  event_class?: string
  source_worker?: string
  limit?: number
}

export interface SugarEvent {
  log_id: number
  timestamp: string
  event_class: string
  source_worker: string
  payload_snapshot: string
}

export interface SugarStatus {
  row_count: number
  last_event_timestamp: string | null
}

// ── SugarDB ────────────────────────────────────────────────────────────

export class SugarDB {
  private db: Database.Database

  constructor(dbPath: string) {
    // Ensure parent directory exists
    mkdirSync(dirname(dbPath), { recursive: true })

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')

    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        event_class TEXT NOT NULL,
        source_worker TEXT NOT NULL,
        payload_snapshot TEXT NOT NULL
      )
    `)

    // Index for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_class ON events(event_class)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_worker ON events(source_worker)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC)
    `)
  }

  logEvent(input: LogEventInput): { log_id: number; timestamp: string } {
    const stmt = this.db.prepare(`
      INSERT INTO events (event_class, source_worker, payload_snapshot)
      VALUES (?, ?, ?)
    `)
    const payload = typeof input.payload_snapshot === 'string'
      ? input.payload_snapshot
      : JSON.stringify(input.payload_snapshot)

    const result = stmt.run(input.event_class, input.source_worker, payload)
    const inserted = this.db.prepare('SELECT log_id, timestamp FROM events WHERE log_id = ?')
      .get(result.lastInsertRowid) as SugarEvent

    return { log_id: inserted.log_id, timestamp: inserted.timestamp }
  }

  queryEvents(input: QueryEventsInput = {}): SugarEvent[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (input.event_class) {
      conditions.push('event_class = ?')
      params.push(input.event_class)
    }
    if (input.source_worker) {
      conditions.push('source_worker = ?')
      params.push(input.source_worker)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = input.limit ?? 100

    const sql = `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ?`
    params.push(limit)

    return this.db.prepare(sql).all(...params) as SugarEvent[]
  }

  status(): SugarStatus {
    const row = this.db.prepare(`
      SELECT COUNT(*) as row_count, MAX(timestamp) as last_event_timestamp FROM events
    `).get() as { row_count: number; last_event_timestamp: string | null }

    return {
      row_count: row.row_count,
      last_event_timestamp: row.last_event_timestamp,
    }
  }

  close(): void {
    this.db.close()
  }
}
