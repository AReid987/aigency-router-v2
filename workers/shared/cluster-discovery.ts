/**
 * ClusterDiscovery — Tailscale peer discovery via an injectable transport.
 *
 * Polls a TailscaleTransport at a configurable interval, diffs against the
 * known peer set, and emits nodeUp / nodeDown events on transitions.
 * Integrates with TelemetryDeps for structured observability.
 *
 * Production Tailscale deployment is out of scope; verification uses
 * localhost + fake Tailscale IP range (100.64.0.0/10) injected via
 * configuration.
 */

import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { type TelemetryDeps, logTelemetry } from './telemetry.ts'

export interface PeerInfo {
  /** Unique peer identifier (host:port) */
  id: string
  host: string
  port: number
  /** Whether the peer responded to the last health check */
  healthy: boolean
  /** Timestamp of last successful poll */
  lastSeen: number
}

export interface TailscaleTransport {
  /** Fetch current peer list from Tailscale (or a fake source) */
  getPeers(): Promise<PeerInfo[]>
}

export interface ClusterDiscoveryOptions {
  /** Polling interval in ms. Default: 10_000 */
  pollIntervalMs?: number
  /** Telemetry dependencies for emitting cluster events */
  telemetryDeps?: TelemetryDeps
  /** Source worker name for telemetry */
  sourceWorker?: string
}

/**
 * Default transport that reads the peer list from `TAILSCALE_PEERS_URL`.
 *
 * Supports:
 * - `file:///path/to/peers.json` — read a local JSON file (used for fake
 *   Tailscale setup during testing/development)
 * - `http://` / `https://` — fetch from a real Tailscale API endpoint
 * - Empty / unset — returns an empty list (safe default for when Tailscale
 *   integration is not configured)
 */
export class HttpTailscaleTransport implements TailscaleTransport {
  private readonly url: string

  constructor(url?: string) {
    this.url = url ?? process.env.TAILSCALE_PEERS_URL ?? ''
  }

  async getPeers(): Promise<PeerInfo[]> {
    if (!this.url) return []

    const parsed = new URL(this.url)

    if (parsed.protocol === 'file:') {
      const content = await readFile(parsed.pathname, 'utf-8')
      return JSON.parse(content) as PeerInfo[]
    }

    // HTTP(S) — native fetch is available in Node 20+
    const resp = await fetch(this.url)
    if (!resp.ok) {
      throw new Error(
        `Tailscale transport HTTP ${resp.status} ${resp.statusText}`,
      )
    }
    return resp.json() as Promise<PeerInfo[]>
  }
}

/**
 * ClusterDiscovery polls a TailscaleTransport for peer information,
 * diffs the result against the known set, and emits structured events.
 *
 * Events (via EventEmitter and optional callback hooks):
 * - `nodeUp` / `onNodeUp(peer)`: a new peer was discovered
 * - `nodeDown` / `onNodeDown(peer)`: a known peer disappeared
 *
 * Telemetry integration emits CLUSTER_NODE_DISCOVERED and
 * CLUSTER_NODE_LOST events when telemetryDeps are configured.
 */
export class ClusterDiscovery extends EventEmitter {
  private readonly pollIntervalMs: number
  private readonly telemetryDeps?: TelemetryDeps
  private readonly sourceWorker: string
  private readonly transport: TailscaleTransport
  private peers: Map<string, PeerInfo> = new Map()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  /** Callback hook for nodeUp discovery events */
  onNodeUp: ((peer: PeerInfo) => void) | null = null
  /** Callback hook for nodeDown loss events */
  onNodeDown: ((peer: PeerInfo) => void) | null = null

  constructor(
    options: ClusterDiscoveryOptions = {},
    transport?: TailscaleTransport,
  ) {
    super()
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000
    this.telemetryDeps = options.telemetryDeps
    this.sourceWorker = options.sourceWorker ?? 'cluster-discovery'
    this.transport = transport ?? new HttpTailscaleTransport()
  }

  /**
   * Start polling the transport. Performs an immediate poll, then
   * polls at the configured interval.
   */
  async start(): Promise<void> {
    this.stopped = false

    // Immediate poll so the caller has data right away
    await this.poll()

    // Periodic polling
    this.pollTimer = setInterval(() => {
      if (!this.stopped) {
        this.poll().catch((err) => {
          console.warn('[cluster-discovery] Poll error:', err)
        })
      }
    }, this.pollIntervalMs)
  }

  /**
   * Stop polling and reset. Clears the timer, all listeners, and the
   * peer map.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.removeAllListeners()
    this.peers.clear()
  }

  /** Return a snapshot of all known peers. */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values())
  }

  /** Internal poll: fetch peer list, diff, emit events. */
  private async poll(): Promise<void> {
    let currentPeers: PeerInfo[]
    try {
      currentPeers = await this.transport.getPeers()
    } catch (err) {
      console.warn('[cluster-discovery] Transport error:', err)
      return
    }

    const currentIds = new Set(currentPeers.map((p) => p.id))

    // Detect new or updated peers
    for (const peer of currentPeers) {
      const existing = this.peers.get(peer.id)
      if (!existing) {
        // New peer discovered
        this.peers.set(peer.id, peer)
        this.onNodeUp?.(peer)
        this.emit('nodeUp', peer)
        if (this.telemetryDeps) {
          logTelemetry(this.telemetryDeps, {
            eventClass: 'CLUSTER_NODE_DISCOVERED',
            sourceWorker: this.sourceWorker,
            payload: {
              nodeId: peer.id,
              host: peer.host,
              port: peer.port,
              reason: 'discovered',
            },
          })
        }
      } else {
        // Update existing peer metadata
        existing.lastSeen = peer.lastSeen
        existing.healthy = peer.healthy
      }
    }

    // Detect removed peers
    for (const [id, peer] of this.peers) {
      if (!currentIds.has(id)) {
        this.peers.delete(id)
        this.onNodeDown?.(peer)
        this.emit('nodeDown', peer)
        if (this.telemetryDeps) {
          logTelemetry(this.telemetryDeps, {
            eventClass: 'CLUSTER_NODE_LOST',
            sourceWorker: this.sourceWorker,
            payload: {
              nodeId: id,
              host: peer.host,
              port: peer.port,
              reason: 'disappeared',
            },
          })
        }
      }
    }
  }
}
