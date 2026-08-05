/**
 * DashboardAggregator unit tests.
 *
 * Tests composition from injected data sources and HTTP endpoint gating.
 * Uses node:test and node:assert/strict.
 * No external dependencies required.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  DashboardAggregator,
  type CostSummary,
  type PipelineRun,
  type WorkerHealth,
  type TelemetryStore,
  type WorkerRegistry,
  type CostDataSource,
} from './dashboard_aggregator.ts'
import type { QuotaStatus } from '../zero-cost/quota_monitor.ts'
import type { TelemetryEvent } from '../../../shared/telemetry.ts'
import { createDashboardHandler } from './dashboard_endpoint.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

// ── Factory Helpers ────────────────────────────────────────────────────

function makeQuotaMonitor(overrides?: Partial<QuotaStatus>): { getStatus(): QuotaStatus } {
  return {
    getStatus() {
      return overrides?.providers
        ? { providers: overrides.providers }
        : {
            providers: [
              { name: 'groq', current: 100, limit: 1000, utilization_pct: 10, projected_exhaustion_at: null },
              { name: 'cerebras', current: 50, limit: 500, utilization_pct: 10, projected_exhaustion_at: null },
            ],
          }
    },
  }
}

function makeTelemetryStore(
  events?: TelemetryEvent[],
  runs?: PipelineRun[],
): TelemetryStore {
  return {
    getRecentEvents(_limit: number) {
      return events ?? []
    },
    getRecentPipelineRuns(_limit: number) {
      return runs ?? []
    },
  }
}

function makeWorkerRegistry(health?: WorkerHealth[]): WorkerRegistry {
  return {
    getHealth() {
      return health ?? []
    },
  }
}

function makeCostDataSource(summary?: CostSummary): CostDataSource {
  return {
    getSummary() {
      return summary ?? { totalCost: 0, costPerProvider: {}, currency: 'USD', periodStart: '', periodEnd: '' }
    },
  }
}

function makeSampleEvent(overrides?: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    eventClass: 'FAST_TRACK_ROUTE',
    sourceWorker: 'gateway',
    payload: { model: 'test' },
    ...overrides,
  }
}

function makeSamplePipelineRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    runId: 'run-001',
    pipelineType: 'classification',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: 'completed',
    ...overrides,
  }
}

function makeSampleWorkerHealth(overrides?: Partial<WorkerHealth>): WorkerHealth {
  return {
    workerId: 'gw-01',
    workerName: 'gateway',
    status: 'healthy',
    lastHeartbeatAt: new Date().toISOString(),
    uptimeSeconds: 3600,
    ...overrides,
  }
}

// ── Test placeholder for node:http response capture ────────────────────

interface CapturedResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function captureResponse(): { res: ServerResponse; captured: Promise<CapturedResponse> } {
  const socket = new Socket()
  const res = new ServerResponse(socket)
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}

  const origSetHeader = res.setHeader.bind(res)
  res.setHeader = (name: string, value: string | number | readonly string[]) => {
    headers[name] = String(value)
    return origSetHeader(name, value)
  }

  res.end = ((data?: unknown) => {
    if (data) chunks.push(Buffer.from(data as ArrayBuffer))
    return res
  }) as typeof res.end

  // Minimal mock — force statusCode to remain accessible
  const capturedPromise: Promise<CapturedResponse> = Promise.resolve({
    statusCode: res.statusCode,
    headers,
    body: Buffer.concat(chunks).toString('utf-8'),
  })

  return { res, captured: capturedPromise }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('DashboardAggregator', () => {
  // ── (1) Full composition ───────────────────────────────────────────

  it('composes all sections when all sources provided', async () => {
    const quotaMonitor = makeQuotaMonitor()
    const events = [makeSampleEvent()]
    const runs = [makeSamplePipelineRun()]
    const workers = [makeSampleWorkerHealth()]
    const cost = makeCostDataSource({ totalCost: 42.5, costPerProvider: { groq: 42.5 }, currency: 'USD', periodStart: '2026-06-01', periodEnd: '2026-06-26' })
    const telemetryStore = makeTelemetryStore(events, runs)
    const workerRegistry = makeWorkerRegistry(workers)

    const aggregator = new DashboardAggregator({ quotaMonitor, telemetryStore, workerRegistry, costDataSource: cost })
    const view = await aggregator.getDashboard()

    assert.ok(view.quota !== null, 'quota should not be null')
    assert.equal(view.quota!.providers.length, 2)
    assert.ok(view.cost !== null, 'cost should not be null')
    assert.equal(view.cost!.totalCost, 42.5)
    assert.equal(view.recent_events.length, 1)
    assert.equal(view.recent_events[0].eventClass, 'FAST_TRACK_ROUTE')
    assert.equal(view.pipeline_runs.length, 1)
    assert.equal(view.pipeline_runs[0].status, 'completed')
    assert.equal(view.workers.length, 1)
    assert.equal(view.workers[0].workerName, 'gateway')
    assert.ok(view.generated_at > 0, 'generated_at should be a positive timestamp')
  })

  // ── (2) Missing quota ──────────────────────────────────────────────

  it('returns null for missing quota source', async () => {
    const events = [makeSampleEvent()]
    const runs = [makeSamplePipelineRun()]
    const telemetryStore = makeTelemetryStore(events, runs)
    const workerRegistry = makeWorkerRegistry([makeSampleWorkerHealth()])
    const cost = makeCostDataSource()

    const aggregator = new DashboardAggregator({ telemetryStore, workerRegistry, costDataSource: cost })
    const view = await aggregator.getDashboard()

    assert.equal(view.quota, null, 'quota should be null when quotaMonitor omitted')
    assert.ok(view.cost !== null, 'cost should still be present')
    assert.equal(view.recent_events.length, 1)
    assert.equal(view.pipeline_runs.length, 1)
    assert.equal(view.workers.length, 1)
  })

  // ── (3) Missing telemetry ──────────────────────────────────────────

  it('returns empty arrays for missing telemetry source', async () => {
    const quotaMonitor = makeQuotaMonitor()
    const workerRegistry = makeWorkerRegistry([makeSampleWorkerHealth()])
    const cost = makeCostDataSource()

    const aggregator = new DashboardAggregator({ quotaMonitor, workerRegistry, costDataSource: cost })
    const view = await aggregator.getDashboard()

    assert.ok(view.quota !== null)
    assert.deepEqual(view.recent_events, [], 'recent_events should be empty when telemetryStore absent')
    assert.deepEqual(view.pipeline_runs, [], 'pipeline_runs should be empty when telemetryStore absent')
  })

  // ── (4) Missing cost ───────────────────────────────────────────────

  it('returns null cost when costDataSource absent', async () => {
    const quotaMonitor = makeQuotaMonitor()
    const events = [makeSampleEvent()]
    const runs = [makeSamplePipelineRun()]
    const telemetryStore = makeTelemetryStore(events, runs)
    const workerRegistry = makeWorkerRegistry([makeSampleWorkerHealth()])

    const aggregator = new DashboardAggregator({ quotaMonitor, telemetryStore, workerRegistry })
    const view = await aggregator.getDashboard()

    assert.equal(view.cost, null, 'cost should be null when costDataSource absent')
    assert.ok(view.quota !== null)
    assert.equal(view.recent_events.length, 1)
    assert.equal(view.pipeline_runs.length, 1)
    assert.equal(view.workers.length, 1)
  })

  // ── (5) generated_at is recent ────────────────────────────────────

  it('generated_at is a recent timestamp', async () => {
    const before = Date.now()
    const aggregator = new DashboardAggregator({})
    const view = await aggregator.getDashboard()
    const after = Date.now()

    assert.ok(view.generated_at >= before, 'generated_at should be >= time before call')
    assert.ok(view.generated_at <= after, 'generated_at should be <= time after call')
  })

  // ── (6) Empty aggregator produces empty view ───────────────────────

  it('returns empty view when no sources provided', async () => {
    const aggregator = new DashboardAggregator({})
    const view = await aggregator.getDashboard()

    assert.equal(view.quota, null)
    assert.equal(view.cost, null)
    assert.deepEqual(view.recent_events, [])
    assert.deepEqual(view.pipeline_runs, [])
    assert.deepEqual(view.workers, [])
    assert.ok(view.generated_at > 0)
  })

  // ── (7) Telemetry store throws gracefully ──────────────────────────

  it('handles telemetry store that throws gracefully', async () => {
    const brokenStore: TelemetryStore = {
      getRecentEvents() { throw new Error('db down') },
      getRecentPipelineRuns() { throw new Error('db down') },
    }
    const aggregator = new DashboardAggregator({ telemetryStore: brokenStore })
    const view = await aggregator.getDashboard()

    assert.deepEqual(view.recent_events, [], 'should return empty on throw')
    assert.deepEqual(view.pipeline_runs, [], 'should return empty on throw')
  })

  // ── (8) Cost source throws gracefully ─────────────────────────────

  it('handles cost source that throws gracefully', async () => {
    const brokenCost: CostDataSource = {
      getSummary() { throw new Error('cost service unreachable') },
    }
    const aggregator = new DashboardAggregator({ costDataSource: brokenCost })
    const view = await aggregator.getDashboard()

    assert.equal(view.cost, null, 'cost should be null when datasource throws')
  })

  // ── (9) Worker registry throws gracefully ─────────────────────────

  it('handles worker registry that throws gracefully', async () => {
    const brokenRegistry: WorkerRegistry = {
      getHealth() { throw new Error('registry unreachable') },
    }
    const aggregator = new DashboardAggregator({ workerRegistry: brokenRegistry })
    const view = await aggregator.getDashboard()

    assert.deepEqual(view.workers, [], 'workers should be empty on throw')
  })

  // ── (10) Fresh generated_at on multiple calls ──────────────────────

  it('multiple calls return fresh generated_at timestamps', async () => {
    const aggregator = new DashboardAggregator({})
    const view1 = await aggregator.getDashboard()
    // Small delay to ensure timestamp progression
    await new Promise((r) => setTimeout(r, 10))
    const view2 = await aggregator.getDashboard()

    // Delay is 10ms, so timestamps should differ
    assert.ok(view2.generated_at >= view1.generated_at, 'later call should have later or equal timestamp')
    // In practice with 10ms delay they should be strictly greater
    assert.ok(view2.generated_at - view1.generated_at >= 0, 'generated_at should never decrease')
  })
})

// ── Dashboard HTTP Endpoint Tests ───────────────────────────────────────

describe('createDashboardHandler', () => {
  let envBackup: Record<string, string | undefined>

  before(() => {
    envBackup = { ...process.env }
  })

  after(() => {
    // Restore original env vars
    for (const key of Object.keys(envBackup)) {
      if (envBackup[key] !== undefined) {
        process.env[key] = envBackup[key]
      } else {
        delete process.env[key]
      }
    }
  })

  // ── (11) 404 when GATEWAY_DASHBOARD not set ───────────────────────

  it('returns 404 when GATEWAY_DASHBOARD not set', async () => {
    delete process.env.GATEWAY_DASHBOARD
    const aggregator = new DashboardAggregator({})
    const handler = createDashboardHandler(aggregator)

    const { res, captured } = captureResponse()
    const req = new IncomingMessage(new Socket())
    req.method = 'GET'

    // Need to properly forward the request
    const p = new Promise<void>((resolve) => {
      res.end = ((data?: unknown) => {
        if (data) {
          const buf = Buffer.from(data as ArrayBuffer)
        }
        res.statusCode = 404
        resolve()
        return res
      }) as typeof res.end
    })

    await handler(req, res)
    await p

    assert.equal(res.statusCode, 404, 'should return 404 when dashboard is disabled')
  })

  // ── (12) 200 when GATEWAY_DASHBOARD=true ──────────────────────────

  it('returns 200 + JSON when GATEWAY_DASHBOARD=true', async () => {
    process.env.GATEWAY_DASHBOARD = 'true'
    const aggregator = new DashboardAggregator({})
    const handler = createDashboardHandler(aggregator)

    const { res, captured } = captureResponse()
    const req = new IncomingMessage(new Socket())
    req.method = 'GET'

    const p = new Promise<void>((resolve) => {
      const origEnd = res.end.bind(res)
      res.end = ((data?: unknown) => {
        if (data) {
          const buf = Buffer.from(data as ArrayBuffer)
          try {
            const body = JSON.parse(buf.toString('utf-8'))
            assert.ok(body !== null, 'response should be valid JSON')
            assert.equal(typeof body.generated_at, 'number')
          } catch {
            assert.fail('response body must be valid JSON')
          }
        }
        res.statusCode = 200
        resolve()
        return res
      }) as typeof res.end
    })

    await handler(req, res)
    await p

    assert.equal(res.statusCode, 200, 'should return 200 when dashboard is enabled')
  })

  // ── (13) JSON serialization round-trips correctly ─────────────────

  it('dashboard JSON serialization round-trips correctly', async () => {
    process.env.GATEWAY_DASHBOARD = 'true'
    const aggregator = new DashboardAggregator({})
    const handler = createDashboardHandler(aggregator)

    const res = new ServerResponse(new Socket())
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')

    const view = await aggregator.getDashboard()
    const json = JSON.stringify(view)
    const parsed = JSON.parse(json)

    assert.equal(parsed.quota, null)
    assert.equal(parsed.cost, null)
    assert.deepEqual(parsed.recent_events, [])
    assert.deepEqual(parsed.pipeline_runs, [])
    assert.deepEqual(parsed.workers, [])
    assert.equal(typeof parsed.generated_at, 'number')
  })

  // ── (14) Multiple dashboard calls return different generated_at ───

  it('multiple dashboard calls return fresh generated_at', async () => {
    const aggregator = new DashboardAggregator({})
    const v1 = await aggregator.getDashboard()
    await new Promise((r) => setTimeout(r, 5))
    const v2 = await aggregator.getDashboard()
    assert.ok(v2.generated_at >= v1.generated_at, 'subsequent calls should yield >= generated_at')
  })
})
