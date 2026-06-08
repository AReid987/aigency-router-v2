/**
 * ClusterRegistry — zero-config LAN node discovery via Bonjour/mDNS.
 *
 * Publishes the local node as `_aigency-slm._tcp` and discovers other
 * nodes on the same LAN. Tracks node health with periodic checks and
 * auto-removes stale nodes.
 */

import { EventEmitter } from 'node:events'
import { type TelemetryDeps, logTelemetry } from './telemetry.ts'

export interface ClusterNode {
  /** Unique node identifier (host:port) */
  id: string
  host: string
  port: number
  /** Timestamp of last successful health check or discovery */
  lastSeen: number
}

export interface ClusterRegistryOptions {
  /** Service type for Bonjour. Default: `_aigency-slm._tcp` */
  serviceName?: string
  /** Port to publish on. Default: 0 (random) */
  port?: number
  /** Telemetry dependencies for emitting cluster events */
  telemetryDeps?: TelemetryDeps
  /** Source worker name for telemetry */
  sourceWorker?: string
  /** Health check interval in ms. Default: 30_000 */
  healthCheckIntervalMs?: number
  /** Stale threshold in ms. Default: 90_000 */
  staleThresholdMs?: number
}

// Minimal interface for bonjour-service's Bonjour instance
interface BonjourInstance {
  publish: (opts: { name: string; type: string; port: number }) => { stop: () => void }
  find: (opts: { type: string }, cb: (service: BonjourService) => void) => { stop: () => void }
  destroy: () => void
}

interface BonjourService {
  name: string
  host: string
  port: number
  addresses?: string[]
}

// Allow injecting bonjour-service for testing
export interface BonjourFactory {
  create: () => BonjourInstance
}

export class ClusterRegistry extends EventEmitter {
  private readonly serviceName: string
  private readonly port: number
  private readonly telemetryDeps?: TelemetryDeps
  private readonly sourceWorker: string
  private readonly healthCheckIntervalMs: number
  private readonly staleThresholdMs: number
  private readonly bonjourFactory: BonjourFactory

  private bonjour: BonjourInstance | null = null
  private publishedService: { stop: () => void } | null = null
  private browser: { stop: () => void } | null = null
  private nodes: Map<string, ClusterNode> = new Map()
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null

  onNodeUp: ((node: ClusterNode) => void) | null = null
  onNodeDown: ((node: ClusterNode) => void) | null = null

  constructor(options: ClusterRegistryOptions = {}, bonjourFactory?: BonjourFactory) {
    super()
    this.serviceName = options.serviceName ?? '_aigency-slm._tcp'
    this.port = options.port ?? 0
    this.telemetryDeps = options.telemetryDeps
    this.sourceWorker = options.sourceWorker ?? 'cluster-registry'
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 30_000
    this.staleThresholdMs = options.staleThresholdMs ?? 90_000
    this.bonjourFactory = bonjourFactory ?? {
      create: () => {
        // Dynamic import bonjour-service
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const BonjourModule = require('bonjour-service')
        const Bonjour = BonjourModule.default ?? BonjourModule.Bonjour ?? BonjourModule
        return new Bonjour()
      },
    }
  }

  async start(): Promise<void> {
    this.bonjour = this.bonjourFactory.create()

    // Publish local node
    this.publishedService = this.bonjour.publish({
      name: `aigency-node-${process.pid}`,
      type: this.serviceName,
      port: this.port,
    })

    // Browse for other nodes
    this.browser = this.bonjour.find({ type: this.serviceName }, (service: BonjourService) => {
      const nodeId = `${service.host}:${service.port}`
      const node: ClusterNode = {
        id: nodeId,
        host: service.host ?? service.addresses?.[0] ?? 'unknown',
        port: service.port,
        lastSeen: Date.now(),
      }

      const isNew = !this.nodes.has(nodeId)
      this.nodes.set(nodeId, node)

      if (isNew) {
        this.onNodeUp?.(node)
        this.emit('nodeUp', node)
        if (this.telemetryDeps) {
          logTelemetry(this.telemetryDeps, {
            eventClass: 'CLUSTER_NODE_DISCOVERED',
            sourceWorker: this.sourceWorker,
            payload: { nodeId, host: node.host, port: node.port },
          })
        }
      } else {
        // Update lastSeen for existing nodes
        this.nodes.get(nodeId)!.lastSeen = Date.now()
      }
    })

    // Start periodic health check
    this.healthCheckTimer = setInterval(() => this.pruneStaleNodes(), this.healthCheckIntervalMs)
  }

  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }

    if (this.publishedService) {
      this.publishedService.stop()
      this.publishedService = null
    }

    if (this.browser) {
      this.browser.stop()
      this.browser = null
    }

    if (this.bonjour) {
      this.bonjour.destroy()
      this.bonjour = null
    }

    this.nodes.clear()
  }

  getNodes(): ClusterNode[] {
    return Array.from(this.nodes.values())
  }

  private pruneStaleNodes(): void {
    const now = Date.now()
    for (const [id, node] of this.nodes) {
      if (now - node.lastSeen > this.staleThresholdMs) {
        this.nodes.delete(id)
        this.onNodeDown?.(node)
        this.emit('nodeDown', node)
        if (this.telemetryDeps) {
          logTelemetry(this.telemetryDeps, {
            eventClass: 'CLUSTER_NODE_LOST',
            sourceWorker: this.sourceWorker,
            payload: { nodeId: id, host: node.host, port: node.port, reason: 'stale' },
          })
        }
      }
    }
  }
}
