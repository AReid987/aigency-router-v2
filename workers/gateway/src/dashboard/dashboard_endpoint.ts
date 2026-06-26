/**
 * Dashboard HTTP endpoint — GET /v1/admin/dashboard
 *
 * Gated on GATEWAY_DASHBOARD=true environment variable.
 * Returns a unified JSON view of quota, cost, telemetry, pipeline runs,
 * and worker health composed by the DashboardAggregator.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { DashboardAggregator } from './dashboard_aggregator.ts'

/**
 * Create an HTTP handler for the dashboard endpoint.
 *
 * @param aggregator - A configured DashboardAggregator instance.
 * @returns A (req, res) handler compatible with node:http.createServer.
 */
export function createDashboardHandler(aggregator: DashboardAggregator) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Gate: GATEWAY_DASHBOARD must be 'true'
    if (process.env.GATEWAY_DASHBOARD !== 'true') {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    // Only accept GET requests to the dashboard path
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    try {
      const view = await aggregator.getDashboard()
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(view))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: `Dashboard aggregation failed: ${message}` }))
    }
  }
}
