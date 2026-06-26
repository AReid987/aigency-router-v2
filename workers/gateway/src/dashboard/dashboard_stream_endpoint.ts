/**
 * Dashboard SSE stream endpoint — GET /v1/admin/dashboard/stream
 *
 * Returns a text/event-stream that emits telemetry events in real-time.
 * Gated on GATEWAY_DASHBOARD_STREAM=true environment variable.
 * Supports Last-Event-ID header for resume (noted as future work).
 * Cleans up subscribers on client disconnect.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { DashboardStream } from './dashboard_stream.ts'

/**
 * Create an HTTP handler for the dashboard SSE stream endpoint.
 *
 * @param stream - A configured DashboardStream instance.
 * @returns A (req, res) handler compatible with node:http.createServer.
 */
export function createDashboardStreamHandler(stream: DashboardStream) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    // Gate: GATEWAY_DASHBOARD_STREAM must be 'true'
    if (process.env.GATEWAY_DASHBOARD_STREAM !== 'true') {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    // Only accept GET requests
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    // Support Last-Event-ID header for resume (documented as future work)
    const lastEventId = req.headers['last-event-id']
    if (lastEventId) {
      // Currently a no-op — the stream starts from the current moment.
      // Future: buffer recent events and replay those after Last-Event-ID.
      // See ADR: M016-S02-stream-resume
    }

    // SSE headers
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // Disable nginx buffering
    res.flushHeaders()

    // Send an initial keepalive comment to confirm the connection
    res.write(':ok\n\n')

    // Subscribe to the stream
    const unsubscribe = stream.addSubscriber((event) => {
      const data = `data: ${JSON.stringify(event)}\n\n`
      res.write(data)
    })

    // Clean up on client disconnect
    res.on('close', () => {
      unsubscribe()
    })
  }
}
