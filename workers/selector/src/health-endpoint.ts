/**
 * HealthEndpoint — lightweight HTTP health check server for the selector worker.
 *
 * Exposes GET /health returning JSON with model name and worker status.
 * Designed for peer discovery and offload targeting in the cluster.
 *
 * No external dependencies — uses only `node:http`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface HealthStatus {
  model: string
  status: 'healthy' | 'degraded'
  endpoint: string
  uptimeSec: number
}

export interface StatusRef {
  current: 'healthy' | 'degraded'
}

export interface HealthEndpointHandle {
  /** The port the server is actually listening on (may differ from requested if 0 was passed). */
  port: number
  /** The health check URL. */
  url: string
  /** Shut down the server. Returns a promise that resolves once the server is fully closed. */
  stop: () => Promise<void>
}

/**
 * Start an HTTP health endpoint on the specified port.
 *
 * @param port - TCP port to listen on (0 = random available port). The resolved
 *               port is available on the returned handle's `port` property.
 * @param model - Model name to advertise in the health response.
 * @param statusRef - Mutable reference for dynamic status updates.
 * @returns A handle with port, url, and stop(). The server starts listening
 *          asynchronously — use `await healthEndpointReady(handle)` when you
 *          need to wait for the listening state.
 */
export function startHealthEndpoint(
  port: number,
  model: string,
  statusRef: StatusRef,
): HealthEndpointHandle {
  const startTime = Date.now()
  const server = createServer()

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const start = Date.now()
    const { method, url: path } = req

    if (method === 'GET' && path === '/health') {
      const body: HealthStatus = {
        model,
        status: statusRef.current,
        endpoint: `http://127.0.0.1:${port}/health`,
        uptimeSec: Math.floor((Date.now() - startTime) / 1000),
      }

      const json = JSON.stringify(body)
      const latencyMs = Date.now() - start

      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(json),
      })
      res.end(json)

      console.log(JSON.stringify({
        event: 'health_request',
        method,
        path,
        statusCode: 200,
        latencyMs,
      }))
    } else {
      const statusCode = method !== 'GET' ? 405 : 404
      const json = JSON.stringify({ error: statusCode === 405 ? 'Method Not Allowed' : 'Not Found' })
      const latencyMs = Date.now() - start

      res.writeHead(statusCode, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(json),
      })
      res.end(json)

      console.log(JSON.stringify({
        event: 'health_request',
        method,
        path,
        statusCode,
        latencyMs,
      }))
    }
  })

  server.listen(port, '127.0.0.1')

  // Listen for listening event to update the resolved port
  server.on('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      port = addr.port
    }
  })

  return {
    get port() {
      return port
    },
    get url() {
      return `http://127.0.0.1:${port}/health`
    },
    stop: (): Promise<void> => {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
    },
  }
}

/**
 * Wait for the health endpoint to start listening. Resolves once the server
 * is ready to accept connections. This is required when using port=0 (random)
 * so the handle's `.port` getter returns the correct value.
 */
export async function waitForHealthEndpoint(
  handle: HealthEndpointHandle,
  maxWait = 2_000,
): Promise<void> {
  const deadline = Date.now() + maxWait
  while (Date.now() < deadline) {
    if (handle.port > 0) {
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('Health endpoint did not become ready within timeout')
}
