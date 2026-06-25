/**
 * Shared telemetry helper — fire-and-forget event emission to SugarDB.
 * 
 * Uses sdk.trigger('sugar-db', 'log_event', ...) under the hood.
 * Gracefully degrades if SugarDB is unavailable (logs warning, never blocks).
 */

export type EventClass =
  | 'FAST_TRACK_ROUTE'
  | 'PROVIDER_FAILOVER'
  | 'QUOTA_WARNING'
  | 'DRIFT_HEALED'
  | 'KEY_ROTATED'
  | 'PROVIDER_RESOLVED'
  | 'SLM_CLASSIFY'
  | 'CLUSTER_NODE_DISCOVERED'
  | 'CLUSTER_NODE_LOST'
  | 'OFFLOAD_DECISION'
  | 'OFFLOAD_FORWARDED'
  | 'OFFLOAD_FALLBACK'
  | 'GATE_EVALUATED'
  | 'GATE_FAILED'
  | 'GATE_HALLUCINATION_DETECTED'
  | 'TASK_DISPATCHED'
  | 'TASK_AGGREGATED'
  | 'PEER_REVIEW_STARTED'
  | 'PEER_REVIEW_COMPLETED'
  | 'PEER_REVIEW_FAILED_CONSENSUS'

export interface TelemetryEvent {
  eventClass: EventClass
  sourceWorker: string
  payload: Record<string, unknown>
}

export interface TelemetryDeps {
  trigger: (target: string, fnName: string, input: unknown) => Promise<unknown>
}

/**
 * Log a telemetry event to SugarDB. Fire-and-forget — never throws.
 * 
 * @param deps - Must provide `trigger` (iii SDK or mock)
 * @param event - Event details
 */
export async function logTelemetry(
  deps: TelemetryDeps,
  event: TelemetryEvent,
): Promise<void> {
  try {
    await deps.trigger('sugar-db', 'log_event', {
      eventClass: event.eventClass,
      sourceWorker: event.sourceWorker,
      payload: event.payload,
    })
  } catch (err) {
    // Graceful degradation — log warning but never block the request path
    console.warn(`[telemetry] Failed to emit ${event.eventClass} from ${event.sourceWorker}:`, err)
  }
}
