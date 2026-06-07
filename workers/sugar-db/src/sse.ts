import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { SugarEvent } from './db.ts'

export type EventBroadcaster = (event: SugarEvent) => void

/**
 * Creates an HTTP server that streams SugarDB events via SSE.
 * Returns the server instance, a broadcast function, and a promise
 * that resolves with the port once the server is listening.
 */
export function createSseServer(port: number = 3115): {
  server: Server
  broadcast: EventBroadcaster
  ready: Promise<number>
} {
  const clients = new Set<ServerResponse>()

  function broadcast(event: SugarEvent) {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const client of clients) {
      try {
        client.write(data)
      } catch {
        clients.delete(client)
      }
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.url === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      // Send initial comment to establish connection
      res.write(':ok\n\n')

      clients.add(res)

      req.on('close', () => {
        clients.delete(res)
      })

      return
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', clients: clients.size }))
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  const ready = new Promise<number>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      console.log(`[sugar-db] SSE server listening on http://127.0.0.1:${actualPort}/events`)
      resolve(actualPort)
    })
  })

  return { server, broadcast, ready }
}
