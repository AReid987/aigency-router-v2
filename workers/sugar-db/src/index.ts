import { registerWorker, type ISdk } from 'iii-sdk'
import { SugarDB, type LogEventInput, type QueryEventsInput } from './db.ts'
import { createSseServer, type EventBroadcaster } from './sse.ts'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'
const DB_PATH = process.env.SUGAR_DB_PATH ?? 'data/sugar.db'
const SSE_PORT = parseInt(process.env.SSE_PORT ?? '3115', 10)

// ── SugarDB Worker ─────────────────────────────────────────────────────

export function createSugarDbWorker(
  url: string = ENGINE_URL,
  dbPath: string = DB_PATH,
  ssePort: number = SSE_PORT,
): { iii: ISdk; broadcast: EventBroadcaster } {
  const db = new SugarDB(dbPath)
  const { server: _sseServer, broadcast } = createSseServer(ssePort)

  const iii = registerWorker(url, { workerName: 'sugar-db' })

  iii.registerFunction('sugar-db::log_event', async (input: LogEventInput) => {
    const result = db.logEvent(input)
    // Broadcast the full event over SSE
    broadcast({
      log_id: result.log_id,
      timestamp: result.timestamp,
      event_class: input.event_class,
      source_worker: input.source_worker,
      payload_snapshot: typeof input.payload_snapshot === 'string'
        ? input.payload_snapshot
        : JSON.stringify(input.payload_snapshot),
    })
    return result
  })

  iii.registerFunction('sugar-db::query_events', async (input: QueryEventsInput = {}) => {
    return db.queryEvents(input)
  })

  iii.registerFunction('sugar-db::status', async () => {
    return db.status()
  })

  // Graceful shutdown
  const shutdown = () => {
    db.close()
    _sseServer.close()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return { iii, broadcast }
}

// Start if run directly
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const { iii } = createSugarDbWorker()
  console.log('[sugar-db] Worker registered — listening on', ENGINE_URL)

  process.on('SIGTERM', async () => {
    await iii.shutdown()
    process.exit(0)
  })
}
