/**
 * OffloadRouter — offload classification decisions to healthy cluster peers.
 *
 * Wraps a local Selector with a ClusterDiscovery-backed peer check.
 * When a healthy peer is available, forwards classification via HTTP POST
 * to the peer's /classify endpoint. When no peer is healthy or the forward
 * fails, falls back to the local selector.
 *
 * Both paths emit structured telemetry events (OFFLOAD_DECISION,
 * OFFLOAD_FORWARDED, OFFLOAD_FALLBACK) when telemetryDeps are configured.
 */

import { randomUUID } from 'node:crypto'
import type { ModelRequest, Classification, Selector } from '../vault/src/selector.ts'
import type { ClusterDiscovery } from './cluster-discovery.ts'
import { type TelemetryDeps, type EventClass, logTelemetry } from './telemetry.ts'

export interface OffloadRouterOptions {
  /** Local selector to use when no peer is available or forward fails */
  localSelector: Selector
  /** Cluster discovery for peer health information */
  clusterDiscovery: ClusterDiscovery
  /** Telemetry dependencies for structured event emission */
  telemetryDeps?: TelemetryDeps
  /** Custom fetch implementation for testing. Defaults to global fetch. */
  fetchFn?: typeof globalThis.fetch
}

export class OffloadRouter {
  private readonly localSelector: Selector
  private readonly clusterDiscovery: ClusterDiscovery
  private readonly telemetryDeps?: TelemetryDeps
  private readonly fetchFn: typeof globalThis.fetch

  constructor(options: OffloadRouterOptions) {
    this.localSelector = options.localSelector
    this.clusterDiscovery = options.clusterDiscovery
    this.telemetryDeps = options.telemetryDeps
    this.fetchFn = options.fetchFn ?? globalThis.fetch
  }

  /**
   * Classify a model request.
   *
   * 1. Fetches peers from cluster discovery
   * 2. Filters to healthy peers
   * 3. If a healthy peer exists: forwards classification via HTTP POST
   * 4. Otherwise: falls back to the local selector
   *
   * Emits structured telemetry on both paths.
   */
  async classify(request: ModelRequest): Promise<Classification> {
    const startTime = Date.now()
    const requestId = randomUUID()
    const peers = this.clusterDiscovery.getPeers()
    const healthyPeers = peers.filter((p) => p.healthy)

    // ── Offload path: forward to first healthy peer ──────────────────
    if (healthyPeers.length > 0) {
      const peer = healthyPeers[0]

      await this.emitTelemetry('OFFLOAD_DECISION', {
        peerId: peer.id,
        requestId,
        reason: 'peer_healthy',
      })

      try {
        const forwardUrl = `http://${peer.host}:${peer.port}/classify`
        const response = await this.fetchFn(forwardUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ request }),
        })

        if (!response.ok) {
          throw new Error(`Peer returned HTTP ${response.status}`)
        }

        const data = (await response.json()) as { classification: Classification }
        const latencyMs = Date.now() - startTime

        await this.emitTelemetry('OFFLOAD_FORWARDED', {
          peerId: peer.id,
          requestId,
          latencyMs,
          classification: data.classification,
        })

        return data.classification
      } catch (err) {
        // Forward failed — fallback to local.
        // classifyLocal handles OFFLOAD_FALLBACK telemetry.
        return this.classifyLocal(request, Date.now(), {
          fallbackReason: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // ── Fallback path: no healthy peers ────────────────────────────
    await this.emitTelemetry('OFFLOAD_DECISION', {
      reason: 'no_healthy_peer',
    })

    return this.classifyLocal(request, startTime)
  }

  /**
   * Run classification via the local selector. Handles both sync
   * (HeuristicSelector) and async (SLMSelector) classify methods.
   */
  private async classifyLocal(
    request: ModelRequest,
    startTime: number,
    extra?: { fallbackReason?: string },
  ): Promise<Classification> {
    const result = this.localSelector.classify(request)
    const classification: Classification =
      result instanceof Promise ? await result : result
    const latencyMs = Date.now() - startTime

    const payload: Record<string, unknown> = {
      classification,
      latencyMs,
    }
    if (extra?.fallbackReason) {
      payload.reason = extra.fallbackReason
    }

    await this.emitTelemetry('OFFLOAD_FALLBACK', payload)

    return classification
  }

  private async emitTelemetry(
    eventClass: EventClass,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.telemetryDeps) return
    await logTelemetry(this.telemetryDeps, {
      eventClass,
      sourceWorker: 'offload-router',
      payload,
    })
  }
}
