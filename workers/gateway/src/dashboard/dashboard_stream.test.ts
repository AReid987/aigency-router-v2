/**
 * DashboardStream + DashboardStreamHandler unit tests.
 *
 * Tests both the DashboardStream class and the HTTP handler.
 * Uses node:test + node:assert/strict, following existing gateway patterns.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { DashboardStream } from './dashboard_stream.ts'
import { createDashboardStreamHandler } from './dashboard_stream_endpoint.ts'
import type { TelemetryEvent } from '../../../shared/telemetry.ts'

// ── Helpers ────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventClass: 'QUOTA_ALERT',
    sourceWorker: 'gateway',
    payload: { provider: 'groq' },
    ...overrides,
  }
}

/**
 * Create a mock ServerResponse compatible with the SSE handler.
 * Uses EventEmitter so the handler's `res.on('close', ...)` works.
 */
function makeMockResponse(): EventEmitter & {
  written: string[]
  statusCode: number
  setHeader(name: string, value: string): any
  getHeader(name: string): string | undefined
  flushHeaders(): void
  end(data?: string): void
  write(data: string): boolean
  headers: Record<string, string>
} {
  const res = new EventEmitter() as any
  const written: string[] = []
  res.statusCode = 200
  res.written = written
  res.headers = {}

  res.write = (data: string) => { written.push(data); return true }
  res.end = (data?: string) => {
    if (data) written.push(data)
    res.emit('finish')
  }
  res.flushHeaders = () => {}
  res.getHeader = (name: string) => res.headers[name.toLowerCase()]
  res.setHeader = (name: string, value: string) => { res.headers[name.toLowerCase()] = value; return res }

  return res
}

function makeMockRequest(method: string = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  const socket = new Socket()
  const req = new IncomingMessage(socket) as any
  req.method = method
  req.headers = headers
  req.url = '/v1/admin/dashboard/stream'
  return req
}

// ── DashboardStream Unit Tests ─────────────────────────────────────────

describe('DashboardStream', () => {
  let eventSource: EventEmitter

  afterEach(() => {
    eventSource.removeAllListeners()
  })

  test('T01: subscribers receive events emitted on eventSource', () => {
    eventSource = new EventEmitter()
    const stream = new DashboardStream({ eventSource })
    const received: TelemetryEvent[] = []

    const unsub = stream.addSubscriber((event) => { received.push(event) })
    const event = makeEvent()
    eventSource.emit('telemetry', event)

    assert.equal(received.length, 1)
    assert.equal(received[0], event)
    unsub()
  })

  test('T02: multiple subscribers all receive the same event', () => {
    eventSource = new EventEmitter()
    const stream = new DashboardStream({ eventSource })
    const received1: TelemetryEvent[] = []
    const received2: TelemetryEvent[] = []

    stream.addSubscriber((e) => { received1.push(e) })
    stream.addSubscriber((e) => { received2.push(e) })
    const event = makeEvent()
    eventSource.emit('telemetry', event)

    assert.equal(received1.length, 1)
    assert.equal(received2.length, 1)
    assert.equal(received1[0], event)
    assert.equal(received2[0], event)
  })

  test('T03: unsubscribe function removes subscriber', () => {
    eventSource = new EventEmitter()
    const stream = new DashboardStream({ eventSource })
    const received: TelemetryEvent[] = []

    const unsub = stream.addSubscriber((e) => { received.push(e) })
    eventSource.emit('telemetry', makeEvent())
    assert.equal(received.length, 1)

    unsub()
    eventSource.emit('telemetry', makeEvent())
    assert.equal(received.length, 1, 'subscriber should not receive after unsubscribe')

    // Verify subscriber count
    assert.equal(stream.subscriberCount(), 0)
  })

  test('T04: telemetry filter rejects events (callback not called)', () => {
    eventSource = new EventEmitter()
    const filter = (e: TelemetryEvent) => e.eventClass === 'COST_ENFORCED'
    const stream = new DashboardStream({ eventSource, telemetryFilter: filter })
    const received: TelemetryEvent[] = []

    stream.addSubscriber((e) => { received.push(e) })
    eventSource.emit('telemetry', makeEvent({ eventClass: 'QUOTA_ALERT' }))
    assert.equal(received.length, 0, 'QUOTA_ALERT should be filtered out')

    eventSource.emit('telemetry', makeEvent({ eventClass: 'COST_ENFORCED' }))
    assert.equal(received.length, 1, 'COST_ENFORCED should pass filter')
  })

  test('T05: dispose removes all subscribers and unsubscribes from eventSource', () => {
    eventSource = new EventEmitter()
    const stream = new DashboardStream({ eventSource })
    const received: TelemetryEvent[] = []

    stream.addSubscriber((e) => { received.push(e) })
    stream.addSubscriber((e) => { received.push(e) })
    assert.equal(stream.subscriberCount(), 2)

    stream.dispose()
    assert.equal(stream.subscriberCount(), 0)

    // Emit after dispose — nothing should arrive
    eventSource.emit('telemetry', makeEvent())
    assert.equal(received.length, 0)
  })

  test('T06: event ordering preserved across multiple events', () => {
    eventSource = new EventEmitter()
    const stream = new DashboardStream({ eventSource })
    const received: TelemetryEvent[] = []

    stream.addSubscriber((e) => { received.push(e) })

    const e1 = makeEvent({ payload: { seq: 1 } })
    const e2 = makeEvent({ payload: { seq: 2 } })
    const e3 = makeEvent({ payload: { seq: 3 } })

    eventSource.emit('telemetry', e1)
    eventSource.emit('telemetry', e2)
    eventSource.emit('telemetry', e3)

    assert.equal(received.length, 3)
    assert.equal(received[0].payload.seq, 1)
    assert.equal(received[1].payload.seq, 2)
    assert.equal(received[2].payload.seq, 3)
  })
})

// ── DashboardStreamHandler (HTTP) Tests ────────────────────────────────

describe('DashboardStreamHandler', () => {
  let eventSource: EventEmitter
  let stream: DashboardStream
  let originalEnv: string | undefined

  afterEach(() => {
    eventSource.removeAllListeners()
    stream.dispose()
    if (originalEnv !== undefined) {
      process.env.GATEWAY_DASHBOARD_STREAM = originalEnv
    } else {
      delete process.env.GATEWAY_DASHBOARD_STREAM
    }
  })

  test('T07: endpoint returns 404 when GATEWAY_DASHBOARD_STREAM not set', () => {
    delete process.env.GATEWAY_DASHBOARD_STREAM
    eventSource = new EventEmitter()
    stream = new DashboardStream({ eventSource })
    const handler = createDashboardStreamHandler(stream)
    const res = makeMockResponse()
    const req = makeMockRequest()

    handler(req as any, res as any)
    assert.equal(res.statusCode, 404)
    assert.ok(res.written[0].includes('Not found'))
  })

  test('T08: endpoint returns 200 + text/event-stream when env set', () => {
    originalEnv = process.env.GATEWAY_DASHBOARD_STREAM
    process.env.GATEWAY_DASHBOARD_STREAM = 'true'
    eventSource = new EventEmitter()
    stream = new DashboardStream({ eventSource })
    const handler = createDashboardStreamHandler(stream)
    const res = makeMockResponse()
    const req = makeMockRequest()

    handler(req as any, res as any)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'text/event-stream')
  })

  test('T09: endpoint writes SSE formatted events on telemetry', () => {
    originalEnv = process.env.GATEWAY_DASHBOARD_STREAM
    process.env.GATEWAY_DASHBOARD_STREAM = 'true'
    eventSource = new EventEmitter()
    stream = new DashboardStream({ eventSource })
    const handler = createDashboardStreamHandler(stream)
    const res = makeMockResponse()
    const req = makeMockRequest()

    handler(req as any, res as any)
    const initialLength = res.written.length

    const event = makeEvent({ eventClass: 'QUOTA_EXHAUSTED', payload: { provider: 'groq' } })
    eventSource.emit('telemetry', event)

    // Should have written one initial keepalive + one data event
    assert.ok(res.written.length >= initialLength + 1)

    // Find the data line (after the keepalive)
    const dataLines = res.written.filter((w: string) => w.startsWith('data: '))
    assert.equal(dataLines.length, 1)

    const parsed = JSON.parse(dataLines[0].slice(6).trim())
    assert.equal(parsed.eventClass, 'QUOTA_EXHAUSTED')
    assert.equal(parsed.sourceWorker, 'gateway')
    assert.deepEqual(parsed.payload, { provider: 'groq' })
  })

  test('T10: endpoint cleans up on simulated client disconnect', () => {
    originalEnv = process.env.GATEWAY_DASHBOARD_STREAM
    process.env.GATEWAY_DASHBOARD_STREAM = 'true'
    eventSource = new EventEmitter()
    stream = new DashboardStream({ eventSource })
    const handler = createDashboardStreamHandler(stream)
    const res = makeMockResponse()
    const req = makeMockRequest()

    handler(req as any, res as any)

    // Simulate client disconnect via close event
    const countBefore = res.written.length
    res.emit('close')

    // After disconnect, events should not be forwarded
    eventSource.emit('telemetry', makeEvent())
    assert.equal(res.written.length, countBefore, 'no writes after disconnect')
  })

  test('T11: endpoint returns 405 for non-GET methods', () => {
    originalEnv = process.env.GATEWAY_DASHBOARD_STREAM
    process.env.GATEWAY_DASHBOARD_STREAM = 'true'
    eventSource = new EventEmitter()
    stream = new DashboardStream({ eventSource })
    const handler = createDashboardStreamHandler(stream)
    const res = makeMockResponse()
    const req = makeMockRequest('POST')

    handler(req as any, res as any)
    assert.equal(res.statusCode, 405)
    assert.ok(res.written[0].includes('Method not allowed'))
  })

  test('T12: Last-Event-ID header is accepted without error', () => {
    originalEnv = process.env.GATEWAY_DASHBOARD_STREAM
    process.env.GATEWAY_DASHBOARD_STREAM = 'true'
    eventSource = new EventEmitter()
    stream = new DashboardStream({ eventSource })
    const handler = createDashboardStreamHandler(stream)
    const res = makeMockResponse()
    const req = makeMockRequest('GET', { 'last-event-id': 'abc123' })

    handler(req as any, res as any)
    assert.equal(res.statusCode, 200)
  })
})
