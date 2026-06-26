/**
 * DashboardAggregator — composes quota, cost, telemetry, pipeline, and worker
 * health data into a single unified DashboardView.
 *
 * Each data source is injected via the constructor; missing sources are handled
 * gracefully (null for scalars, empty arrays for collections).
 */

import type { QuotaStatus } from '../zero-cost/quota_monitor.ts'
import type { TelemetryEvent } from '../../../shared/telemetry.ts'

// ── Dashboard-Level Types ──────────────────────────────────────────────

export interface CostSummary {
  totalCost: number
  costPerProvider: Record<string, number>
  currency: string
  periodStart: string
  periodEnd: string
}

export interface PipelineRun {
  runId: string
  pipelineType: string
  startedAt: string
  completedAt: string | null
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  error?: string
}

export interface WorkerHealth {
  workerId: string
  workerName: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  lastHeartbeatAt: string | null
  uptimeSeconds: number
}

export interface DashboardView {
  quota: QuotaStatus | null
  cost: CostSummary | null
  recent_events: TelemetryEvent[]
  pipeline_runs: PipelineRun[]
  workers: WorkerHealth[]
  generated_at: number
}

// ── Data Source Interfaces ─────────────────────────────────────────────

export interface TelemetryStore {
  getRecentEvents(limit: number): TelemetryEvent[]
  getRecentPipelineRuns(limit: number): PipelineRun[]
}

export interface WorkerRegistry {
  getHealth(): WorkerHealth[]
}

export interface CostDataSource {
  getSummary(): CostSummary
}

// ── DashboardAggregator ────────────────────────────────────────────────

export class DashboardAggregator {
  private readonly quotaMonitor?: { getStatus(): QuotaStatus }
  private readonly telemetryStore?: TelemetryStore
  private readonly workerRegistry?: WorkerRegistry
  private readonly costDataSource?: CostDataSource

  constructor(options: {
    quotaMonitor?: { getStatus(): QuotaStatus }
    telemetryStore?: TelemetryStore
    workerRegistry?: WorkerRegistry
    costDataSource?: CostDataSource
  }) {
    this.quotaMonitor = options.quotaMonitor
    this.telemetryStore = options.telemetryStore
    this.workerRegistry = options.workerRegistry
    this.costDataSource = options.costDataSource
  }

  /**
   * Compose all available data sources into a single DashboardView.
   * Each source is optional — missing sources yield null or empty arrays.
   */
  async getDashboard(): Promise<DashboardView> {
    const quota = this.quotaMonitor?.getStatus() ?? null

    let cost: CostSummary | null = null
    try {
      cost = this.costDataSource?.getSummary() ?? null
    } catch {
      // Cost source failed — return null rather than crashing the dashboard
      cost = null
    }

    let recentEvents: TelemetryEvent[] = []
    try {
      recentEvents = this.telemetryStore?.getRecentEvents(50) ?? []
    } catch {
      recentEvents = []
    }

    let pipelineRuns: PipelineRun[] = []
    try {
      pipelineRuns = this.telemetryStore?.getRecentPipelineRuns(10) ?? []
    } catch {
      pipelineRuns = []
    }

    let workers: WorkerHealth[] = []
    try {
      workers = this.workerRegistry?.getHealth() ?? []
    } catch {
      workers = []
    }

    return {
      quota,
      cost,
      recent_events: recentEvents,
      pipeline_runs: pipelineRuns,
      workers,
      generated_at: Date.now(),
    }
  }
}
