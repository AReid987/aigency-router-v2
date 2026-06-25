/**
 * OffloadRouter unit tests.
 *
 * Tests the decision logic, peer forwarding, fallback, and telemetry
 * emission. Uses injectable fetchFn and mock ClusterDiscovery so no
 * real network calls are made.
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { OffloadRouter, type OffloadRouterOptions } from './offload-router.ts'
import type { ClusterDiscovery } from './cluster-discovery.ts'
import type { ModelRequest, Classification, Selector } from '../vault/src/selector.ts'

// ── Fixtures ───────────────────────────────────────────────────────────

const SIMPLE_REQUEST: ModelRequest = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'hello' }],
}

const COMPLEX_REQUEST: ModelRequest = {
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'user', content: 'd' },
  ],
}

// Mock peer info
const HEALTHY_PEER = {
  id: 'peer-1',
  host: '127.0.0.1',
  port: 9999,
  healthy: true,
  lastSeen: Date.now(),
}

const UNHEALTHY_PEER = {
  id: 'peer-2',
  host: '127.0.0.1',
  port: 9998,
  healthy: false,
  lastSeen: Date.now(),
}

// ── Helpers ────────────────────────────────────────────────────────────

function createMockSelector(returns: Classification = 'simple'): Selector {
  return {
    classify: mock.fn((_req: ModelRequest): Classification => returns),
  }
}

function createAsyncMockSelector(returns: Classification = 'simple'): Selector {
  return {
    classify: mock.fn(
      async (_req: ModelRequest): Promise<Classification> => returns,
    ),
  }
}

function createMockClusterDiscovery(peers: typeof HEALTHY_PEER[]): ClusterDiscovery {
  return {
    getPeers: mock.fn(() => peers),
  } as unknown as ClusterDiscovery
}

interface TelemetryCall {
  eventClass: string
  sourceWorker: string
  payload: Record<string, unknown>
}

function makeOffloadRouter(
  overrides: Partial<OffloadRouterOptions> & {
    mockSelector?: Selector
    mockDiscovery?: ClusterDiscovery
    mockFetch?: typeof globalThis.fetch
  } = {},
): OffloadRouter {
  const mockTelemetryDeps = {
    trigger: mock.fn(async () => ({})),
  }

  const selector = overrides.mockSelector ?? createMockSelector('simple')
  const discovery = overrides.mockDiscovery ?? createMockClusterDiscovery([])
  const telemetryDeps = overrides.telemetryDeps ?? mockTelemetryDeps

  return new OffloadRouter({
    localSelector: selector,
    clusterDiscovery: discovery,
    telemetryDeps,
    fetchFn: overrides.mockFetch,
  })
}

/**
 * Create a mock fetch function that returns a successful classification response.
 */
function mockFetchOk(classification: Classification = 'simple'): typeof globalThis.fetch {
  return mock.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify({ classification }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
}

function mockFetchFails(): typeof globalThis.fetch {
  return mock.fn(async () => {
    return new Response('Internal Server Error', { status: 500 })
  }) as unknown as typeof globalThis.fetch
}

function mockFetchNetworkError(): typeof globalThis.fetch {
  return mock.fn(async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof globalThis.fetch
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('OffloadRouter', () => {
  it('returns local classification when no peers exist', async () => {
    const local = createMockSelector('simple')
    const router = makeOffloadRouter({
      mockSelector: local,
      mockDiscovery: createMockClusterDiscovery([]),
    })

    const result = await router.classify(SIMPLE_REQUEST)

    assert.equal(result, 'simple')
    assert.equal((local.classify as ReturnType<typeof mock.fn>).mock.callCount(), 1)
  })

  it('returns local classification when all peers are unhealthy', async () => {
    const local = createMockSelector('complex')
    const router = makeOffloadRouter({
      mockSelector: local,
      mockDiscovery: createMockClusterDiscovery([UNHEALTHY_PEER]),
    })

    const result = await router.classify(COMPLEX_REQUEST)

    assert.equal(result, 'complex')
    assert.equal((local.classify as ReturnType<typeof mock.fn>).mock.callCount(), 1)
  })

  it('forwards to healthy peer and returns peer classification', async () => {
    const local = createMockSelector('simple')
    const fetchFn = mockFetchOk('complex')
    const router = makeOffloadRouter({
      mockSelector: local,
      mockDiscovery: createMockClusterDiscovery([HEALTHY_PEER]),
      mockFetch: fetchFn,
    })

    const result = await router.classify(SIMPLE_REQUEST)

    assert.equal(result, 'complex')
    // Local selector should NOT be called when forward succeeds
    assert.equal((local.classify as ReturnType<typeof mock.fn>).mock.callCount(), 0)
    // Verify fetch was called with correct URL and body
    const fetchMock = fetchFn as unknown as ReturnType<typeof mock.fn>
    assert.equal(fetchMock.mock.callCount(), 1)
    const callUrl = fetchMock.mock.calls[0].arguments[0]
    assert.ok(callUrl.includes('/classify'), `Expected /classify in URL, got: ${callUrl}`)
    const callInit = fetchMock.mock.calls[0].arguments[1] as RequestInit
    assert.equal((callInit.method ?? '').toUpperCase(), 'POST')
    const body = JSON.parse(callInit.body as string)
    assert.ok(body.request, 'Body should contain request field')
    assert.equal(body.request.model, SIMPLE_REQUEST.model)
  })

  it('falls back to local when forward fails with HTTP error', async () => {
    const local = createMockSelector('simple')
    const fetchFn = mockFetchFails()
    const router = makeOffloadRouter({
      mockSelector: local,
      mockDiscovery: createMockClusterDiscovery([HEALTHY_PEER]),
      mockFetch: fetchFn,
    })

    const result = await router.classify(SIMPLE_REQUEST)

    assert.equal(result, 'simple')
    // Local selector should be called as fallback
    assert.equal((local.classify as ReturnType<typeof mock.fn>).mock.callCount(), 1)
  })

  it('falls back to local when forward fails with network error', async () => {
    const local = createMockSelector('complex')
    const fetchFn = mockFetchNetworkError()
    const router = makeOffloadRouter({
      mockSelector: local,
      mockDiscovery: createMockClusterDiscovery([HEALTHY_PEER]),
      mockFetch: fetchFn,
    })

    const result = await router.classify(COMPLEX_REQUEST)

    assert.equal(result, 'complex')
    assert.equal((local.classify as ReturnType<typeof mock.fn>).mock.callCount(), 1)
  })

  it('handles async local selector (SLMSelector)', async () => {
    const local = createAsyncMockSelector('simple')
    const router = makeOffloadRouter({
      mockSelector: local,
      mockDiscovery: createMockClusterDiscovery([]),
    })

    const result = await router.classify(SIMPLE_REQUEST)

    assert.equal(result, 'simple')
    assert.equal((local.classify as ReturnType<typeof mock.fn>).mock.callCount(), 1)
  })

  it('picks the first healthy peer when multiple exist', async () => {
    const peer1 = { ...HEALTHY_PEER, id: 'peer-a', port: 9001 }
    const peer2 = { ...HEALTHY_PEER, id: 'peer-b', port: 9002 }
    const fetchFn = mockFetchOk('simple')

    // Both healthy — should pick peer-a (first)
    const calls: string[] = []
    const trackingFetch = mock.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ classification: 'simple' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch

    const router = makeOffloadRouter({
      mockDiscovery: createMockClusterDiscovery([peer1, peer2]),
      mockFetch: trackingFetch,
    })

    await router.classify(SIMPLE_REQUEST)

    assert.equal(calls.length, 1)
    assert.ok(calls[0].includes('9001'), `Expected peer-a (9001), got: ${calls[0]}`)
  })

  it('emits OFFLOAD_DECISION and OFFLOAD_FORWARDED on successful forward', async () => {
    const telemetryCalls: TelemetryCall[] = []
    const telemetryDeps = {
      trigger: mock.fn(async (target: string, fnName: string, input: unknown) => {
        const event = input as TelemetryCall
        telemetryCalls.push(event)
        return {}
      }),
    }

    const router = makeOffloadRouter({
      mockDiscovery: createMockClusterDiscovery([HEALTHY_PEER]),
      mockFetch: mockFetchOk('simple'),
      telemetryDeps,
    })

    await router.classify(SIMPLE_REQUEST)

    const eventClasses = telemetryCalls.map((c) => c.eventClass)
    assert.ok(
      eventClasses.includes('OFFLOAD_DECISION'),
      `Expected OFFLOAD_DECISION, got: ${eventClasses.join(', ')}`,
    )
    assert.ok(
      eventClasses.includes('OFFLOAD_FORWARDED'),
      `Expected OFFLOAD_FORWARDED, got: ${eventClasses.join(', ')}`,
    )

    // Verify payload fields
    const decision = telemetryCalls.find((c) => c.eventClass === 'OFFLOAD_DECISION')
    assert.ok(decision)
    assert.equal(decision.payload.peerId, HEALTHY_PEER.id)
    assert.equal(decision.payload.reason, 'peer_healthy')
    assert.ok(decision.payload.requestId)

    const forwarded = telemetryCalls.find((c) => c.eventClass === 'OFFLOAD_FORWARDED')
    assert.ok(forwarded)
    assert.equal(forwarded.payload.peerId, HEALTHY_PEER.id)
    assert.equal(forwarded.payload.classification, 'simple')
    assert.ok(typeof forwarded.payload.latencyMs === 'number')
  })

  it('emits OFFLOAD_DECISION and OFFLOAD_FALLBACK on no healthy peer', async () => {
    const telemetryCalls: TelemetryCall[] = []
    const telemetryDeps = {
      trigger: mock.fn(async (target: string, fnName: string, input: unknown) => {
        const event = input as TelemetryCall
        telemetryCalls.push(event)
        return {}
      }),
    }

    const router = makeOffloadRouter({
      mockDiscovery: createMockClusterDiscovery([]),
      mockSelector: createMockSelector('simple'),
      telemetryDeps,
    })

    await router.classify(SIMPLE_REQUEST)

    const eventClasses = telemetryCalls.map((c) => c.eventClass)
    assert.ok(eventClasses.includes('OFFLOAD_DECISION'))
    assert.ok(eventClasses.includes('OFFLOAD_FALLBACK'))

    const decision = telemetryCalls.find((c) => c.eventClass === 'OFFLOAD_DECISION')
    assert.equal(decision?.payload.reason, 'no_healthy_peer')

    const fallback = telemetryCalls.find((c) => c.eventClass === 'OFFLOAD_FALLBACK')
    assert.ok(fallback)
    assert.equal(fallback.payload.classification, 'simple')
    assert.ok(typeof fallback.payload.latencyMs === 'number')
  })

  it('emits OFFLOAD_FALLBACK on forward failure with reason', async () => {
    const telemetryCalls: TelemetryCall[] = []
    const telemetryDeps = {
      trigger: mock.fn(async (target: string, fnName: string, input: unknown) => {
        const event = input as TelemetryCall
        telemetryCalls.push(event)
        return {}
      }),
    }

    const router = makeOffloadRouter({
      mockDiscovery: createMockClusterDiscovery([HEALTHY_PEER]),
      mockFetch: mockFetchFails(),
      telemetryDeps,
    })

    await router.classify(SIMPLE_REQUEST)

    const fallback = telemetryCalls.find((c) => c.eventClass === 'OFFLOAD_FALLBACK')
    assert.ok(fallback, 'Expected OFFLOAD_FALLBACK event')
    assert.ok(fallback.payload.reason, 'Fallback should include reason')
    assert.equal(fallback.payload.classification, 'simple')
  })

  it('does not emit telemetry when telemetryDeps is undefined', async () => {
    let telemetryCalled = false
    const triggerSpy = mock.fn(async () => {
      telemetryCalled = true
    })

    const router = new OffloadRouter({
      localSelector: createMockSelector('simple'),
      clusterDiscovery: createMockClusterDiscovery([]) as unknown as ClusterDiscovery,
      telemetryDeps: undefined,
    })

    await router.classify(SIMPLE_REQUEST)

    // Should not throw and local classify should still work
    assert.equal((router['localSelector'].classify as ReturnType<typeof mock.fn>).mock.callCount(), 1)
  })
})
