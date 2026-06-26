/**
 * DashboardStream — real-time event stream for the dashboard SSE endpoint.
 *
 * Subscribes to an EventEmitter-based event source (e.g., a telemetry bus),
 * applies an optional telemetry filter, and fans out matching events to all
 * active subscribers. Each subscriber receives a callback invoked with the
 * TelemetryEvent.
 *
 * Usage:
 *   const stream = new DashboardStream({ eventSource: telemetryBus })
 *   const unsub = stream.addSubscriber((event) => { ... })
 *   // later: unsub()
 */

import { type TelemetryEvent } from '../../../shared/telemetry.ts'
import { EventEmitter } from 'node:events'

// ── Types ──────────────────────────────────────────────────────────────

export interface DashboardStreamOptions {
  /** The EventEmitter that emits 'telemetry' events. */
  eventSource: EventEmitter
  /** Optional filter: only forward events for which this returns true. */
  telemetryFilter?: (event: TelemetryEvent) => boolean
}

export type TelemetrySubscriber = (event: TelemetryEvent) => void

// ── DashboardStream ────────────────────────────────────────────────────

export class DashboardStream {
  private readonly eventSource: EventEmitter
  private readonly telemetryFilter?: (event: TelemetryEvent) => boolean
  private readonly subscribers: Set<TelemetrySubscriber> = new Set()
  private readonly boundHandler: (event: TelemetryEvent) => void
  private subscribed: boolean = false

  constructor(options: DashboardStreamOptions) {
    this.eventSource = options.eventSource
    this.telemetryFilter = options.telemetryFilter
    this.boundHandler = this.handleTelemetryEvent.bind(this)
  }

  /**
   * Register a subscriber callback.
   * Returns an unsubscribe function that removes this subscriber.
   * Lazy-subscribes to the underlying eventSource on first subscriber.
   */
  addSubscriber(callback: TelemetrySubscriber): () => void {
    this.subscribers.add(callback)

    // Subscribe to eventSource lazily on first subscriber
    if (!this.subscribed) {
      this.eventSource.on('telemetry', this.boundHandler)
      this.subscribed = true
    }

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback)

      // Unsubscribe from eventSource when last subscriber leaves
      if (this.subscribers.size === 0 && this.subscribed) {
        this.eventSource.off('telemetry', this.boundHandler)
        this.subscribed = false
      }
    }
  }

  /**
   * Handle an incoming telemetry event from the eventSource.
   * Applies the telemetryFilter if configured, then fans out to all subscribers.
   */
  private handleTelemetryEvent(event: TelemetryEvent): void {
    if (this.telemetryFilter && !this.telemetryFilter(event)) {
      return
    }

    // Forward to all subscribers (fail-safe: catch per subscriber)
    for (const callback of this.subscribers) {
      try {
        callback(event)
      } catch {
        // Silently ignore subscriber errors — never crash the stream
      }
    }
  }

  /**
   * Remove all subscribers and unsubscribe from the eventSource.
   */
  dispose(): void {
    this.subscribers.clear()
    if (this.subscribed) {
      this.eventSource.off('telemetry', this.boundHandler)
      this.subscribed = false
    }
  }

  /**
   * Return the current subscriber count (for testing/inspection).
   */
  subscriberCount(): number {
    return this.subscribers.size
  }
}
