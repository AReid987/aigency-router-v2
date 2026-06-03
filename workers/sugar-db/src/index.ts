import { registerWorker, type ISdk } from 'iii-sdk'
import { SugarDB, type LogEventInput, type QueryEventsInput } from './db.ts'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'
const DB_PATH = process.env.SUGAR_DB_PATH ?? 'data/sugar.db'

// ── SugarDB Worker ─────────────────────────────────────────────────────

export function createSugarDbWorker(url: string = ENGINE_URL, dbPath: string = DB_PATH): ISdk {
  const db = new SugarDB(dbPath)

  const iii = registerWorker(url, { workerName: 'sugar-db' })

  iii.registerFunction('sugar-db::log_event', async (input: LogEventInput) => {
    return db.logEvent(input)
  })

  iii.registerFunction('sugar-db::query_events', async (input: QueryEventsInput = {}) => {
    return db.queryEvents(input)
  })

  iii.registerFunction('sugar-db::status', async () => {
    return db.status()
  })

  // Graceful shutdown
  process.on('SIGTERM', () => {
    db.close()
  })
  process.on('SIGINT', () => {
    db.close()
  })

  return iii
}

// Start if run directly
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const iii = createSugarDbWorker()
  console.log('[sugar-db] Worker registered — listening on', ENGINE_URL)

  process.on('SIGTERM', async () => {
    await iii.shutdown()
    process.exit(0)
  })
}
