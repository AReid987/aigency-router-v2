/**
 * Offload Flow Integration Test
 *
 * Verifies the full offload round-trip with a real peer HTTP server:
 *   1. Forward path: classifies via peer when peer is healthy
 *   2. Fallback path: falls back to local when peer is not in peer list
 *   3. Fallback on forward failure: falls back when forward HTTP request fails
 *   4. Recovery path: offloads again when peer reappears in list
 *   5. Structured telemetry verification
 *
 * Uses a real node:http server for the peer's /classify endpoint.
 * ClusterDiscovery is populated with the appropriate peer state per test
 * scenario — no polling needed since getPeers() returns cached data from
 * the last poll cycle.
 *
 * Run: npx tsx tests/integration/test-offload-flow.ts
 */

import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { ClusterDiscovery, type PeerInfo } from '../../workers/shared/cluster-discovery.ts'
import { OffloadRouter } from '../../workers/shared/offload-router.ts'
import { HeuristicSelector, type ModelRequest, type Classification } from '../../workers/vault/src/selector.ts'

// ── Fixtures ───────────────────────────────────────────────────────────

const SIMPLE_REQUEST: ModelRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
}

const COMPLEX_REQUEST: ModelRequest = {
  model: 'test-model',
  messages: [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'user', content: 'd' },
    { role: 'user', content: 'e' },
  ],
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Create a simple HTTP server that handles POST /classify and GET /health.
 */
function createClassifyServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer()

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const { method, url } = req

      if (method === 'GET' && url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', model: 'test-model' }))
        return
      }

      if (method === 'POST' && url === '/classify') {
        let body = ''
        req.on('data', (chunk: string) => { body += chunk })
        req.on('end', () => {
          try {
            JSON.parse(body) // validate body
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ classification: 'simple' }))
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid JSON' }))
          }
        })
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      resolve({ server, port })
    })
  })
}

/**
 * Create a ClusterDiscovery pre-populated with the given peers by
 * building on top of the poll() mechanism — but since poll() is private,
 * we intercept with a fixed peer list transport that's read on poll.
 *
 * For this test, we manually drive peer state by creating fresh
 * discoveries with the desired peer list, rather than relying on
 * polling to update state mid-test.
 */
function createDiscoveryWithPeers(
  peers: PeerInfo[],
  telemetryDeps: { trigger: ReturnType<typeof mock.fn> },
): ClusterDiscovery {
  let currentPeers = peers

  const transport = {
    getPeers: mock.fn(async () => currentPeers),
  }

  const discovery = new ClusterDiscovery(
    { pollIntervalMs: 600_000, telemetryDeps, sourceWorker: 'test' },
    transport,
  )

  // Manually seed the internal peer map by calling start() which polls once
  // We need to await start, but start is async...
  // Instead, directly call the private poll method via prototype access
  // or use a helper. Actually let's just not call start but instead
  // pre-populate by getting the transport to be read once.
  //
  // The simplest approach: Don't use start() for test — just start it,
  // let it poll, then manually access getPeers().
  discovery.start()

  // Return a wrapped discovery where we can update peers
  const originalGetPeers = discovery.getPeers.bind(discovery)

  // Override getPeers to return our controlled list
  // (ClusterDiscovery's getPeers returns cached from poll, but our
  //  transport hasn't been polled yet since start is async. So we
  //  need to let poll complete first.)

  return discovery
}

/**
 * Helper: wait for server to start accepting connections.
 */
async function waitForServer(server: Server, port: number, maxWait = 2000): Promise<void> {
  const deadline = Date.now() + maxWait
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`)
      if (resp.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('Server did not become ready within timeout')
}

// Collect telemetry events for verification
const telemetryEvents: Array<{
  eventClass: string
  payload: Record<string, unknown>
}> = []

const mockTrigger = mock.fn(async (target: string, fnName: string, input: unknown) => {
  const event = input as { eventClass: string; payload: Record<string, unknown> }
  telemetryEvents.push({ eventClass: event.eventClass, payload: event.payload })
  return {}
})

const mockTelemetryDeps = { trigger: mockTrigger }

// ── Tests ──────────────────────────────────────────────────────────────

describe('Offload Flow Integration', () => {
  let peerServer: Server
  let peerPort: number

  before(async () => {
    // Start the peer classify server once for all tests
    const result = await createClassifyServer()
    peerServer = result.server
    peerPort = result.port
    console.log(`[test] Peer classify server started on port ${peerPort}`)
    await waitForServer(peerServer, peerPort)
  })

  after(async () => {
    await new Promise<void>((resolve) => {
      if (peerServer.listening) {
        peerServer.close(() => resolve())
      } else {
        resolve()
      }
    })
  })

  // ── Forward Path ────────────────────────────────────────────────

  it('forwards classification to peer when peer is healthy', async () => {
    telemetryEvents.length = 0

    const localSelector = new HeuristicSelector()
    const peerInfo: PeerInfo = {
      id: `127.0.0.1:${peerPort}`,
      host: '127.0.0.1',
      port: peerPort,
      healthy: true,
      lastSeen: Date.now(),
    }

    const discovery = new ClusterDiscovery(
      { pollIntervalMs: 600_000, sourceWorker: 'test' },
      { getPeers: async () => [peerInfo] },
    )
    await discovery.start()
    // Give poll a tick to populate
    await new Promise((r) => setTimeout(r, 10))

    const router = new OffloadRouter({
      localSelector,
      clusterDiscovery: discovery,
      telemetryDeps: mockTelemetryDeps,
    })

    const result = await router.classify(SIMPLE_REQUEST)

    assert.equal(result, 'simple')

    const decisionEvent = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_DECISION')
    assert.ok(decisionEvent, 'Should emit OFFLOAD_DECISION')
    assert.equal(decisionEvent!.payload.reason, 'peer_healthy')

    const forwardedEvent = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_FORWARDED')
    assert.ok(forwardedEvent, 'Should emit OFFLOAD_FORWARDED')
    assert.equal(forwardedEvent!.payload.classification, 'simple')
    assert.ok(typeof forwardedEvent!.payload.latencyMs === 'number')

    await discovery.stop()
  })

  it('forwards multiple requests to peer', async () => {
    telemetryEvents.length = 0

    const localSelector = new HeuristicSelector()
    const peerInfo: PeerInfo = {
      id: `127.0.0.1:${peerPort}`,
      host: '127.0.0.1',
      port: peerPort,
      healthy: true,
      lastSeen: Date.now(),
    }

    const discovery = new ClusterDiscovery(
      { pollIntervalMs: 600_000, sourceWorker: 'test' },
      { getPeers: async () => [peerInfo] },
    )
    await discovery.start()
    await new Promise((r) => setTimeout(r, 10))

    const router = new OffloadRouter({
      localSelector,
      clusterDiscovery: discovery,
      telemetryDeps: mockTelemetryDeps,
    })

    for (let i = 0; i < 3; i++) {
      const result = await router.classify(SIMPLE_REQUEST)
      assert.equal(result, 'simple')
    }

    const forwardedEvents = telemetryEvents.filter((e) => e.eventClass === 'OFFLOAD_FORWARDED')
    assert.equal(forwardedEvents.length, 3, 'Should have 3 OFFLOAD_FORWARDED events')

    await discovery.stop()
  })

  // ── Fallback Path ───────────────────────────────────────────────

  it('falls back to local selector when no peers in discovery', async () => {
    telemetryEvents.length = 0

    const localSelector = new HeuristicSelector()
    const discovery = new ClusterDiscovery(
      { pollIntervalMs: 600_000, sourceWorker: 'test' },
      { getPeers: async () => [] },
    )
    await discovery.start()
    await new Promise((r) => setTimeout(r, 10))

    const router = new OffloadRouter({
      localSelector,
      clusterDiscovery: discovery,
      telemetryDeps: mockTelemetryDeps,
    })

    const result = await router.classify(COMPLEX_REQUEST)

    // HeuristicSelector: 5 messages > 3 → 'complex'
    assert.equal(result, 'complex')

    const decisionEvent = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_DECISION')
    assert.ok(decisionEvent, 'Should emit OFFLOAD_DECISION')
    assert.equal(decisionEvent!.payload.reason, 'no_healthy_peer')

    const fallbackEvent = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_FALLBACK')
    assert.ok(fallbackEvent, 'Should emit OFFLOAD_FALLBACK')
    assert.equal(fallbackEvent!.payload.classification, 'complex')
    assert.ok(typeof fallbackEvent!.payload.latencyMs === 'number')

    await discovery.stop()
  })

  it('falls back to local when peer is marked unhealthy', async () => {
    telemetryEvents.length = 0

    const localSelector = new HeuristicSelector()
    const peerInfo: PeerInfo = {
      id: `127.0.0.1:${peerPort}`,
      host: '127.0.0.1',
      port: peerPort,
      healthy: false, // explicitly unhealthy
      lastSeen: Date.now(),
    }

    const discovery = new ClusterDiscovery(
      { pollIntervalMs: 600_000, sourceWorker: 'test' },
      { getPeers: async () => [peerInfo] },
    )
    await discovery.start()
    await new Promise((r) => setTimeout(r, 10))

    const router = new OffloadRouter({
      localSelector,
      clusterDiscovery: discovery,
      telemetryDeps: mockTelemetryDeps,
    })

    const result = await router.classify(SIMPLE_REQUEST)

    assert.equal(result, 'simple')

    const decisionEvent = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_DECISION')
    assert.ok(decisionEvent)
    // No healthy peers → no_healthy_peer
    assert.equal(decisionEvent!.payload.reason, 'no_healthy_peer')

    const fallbackEvent = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_FALLBACK')
    assert.ok(fallbackEvent, 'Should emit OFFLOAD_FALLBACK for unhealthy peer')

    await discovery.stop()
  })

  it('falls back to local when forward request fails (connection refused)', async () => {
    telemetryEvents.length = 0

    const localSelector = new HeuristicSelector()
    // Point to a port with nothing listening
    const deadPeer: PeerInfo = {
      id: '127.0.0.1:1',
      host: '127.0.0.1',
      port: 1,
      healthy: true,
      lastSeen: Date.now(),
    }

    const discovery = new ClusterDiscovery(
      { pollIntervalMs: 600_000, sourceWorker: 'test' },
      { getPeers: async () => [deadPeer] },
    )
    await discovery.start()
    await new Promise((r) => setTimeout(r, 10))

    const router = new OffloadRouter({
      localSelector,
      clusterDiscovery: discovery,
      telemetryDeps: mockTelemetryDeps,
    })

    const result = await router.classify(SIMPLE_REQUEST)

    // Should fall back to local selector on network error
    assert.equal(result, 'simple')

    const fallbackEvent = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_FALLBACK')
    assert.ok(fallbackEvent, 'Should emit OFFLOAD_FALLBACK on forward failure')
    assert.ok(fallbackEvent!.payload.reason, 'Fallback should include error reason')

    await discovery.stop()
  })

  // ── Recovery Path ───────────────────────────────────────────────

  it('re-offloads to peer after previous request used fallback', async () => {
    telemetryEvents.length = 0

    const localSelector = new HeuristicSelector()

    // Step 1: Fallback path — no peers
    const emptyDiscovery = new ClusterDiscovery(
      { pollIntervalMs: 600_000, sourceWorker: 'test' },
      { getPeers: async () => [] },
    )
    await emptyDiscovery.start()
    await new Promise((r) => setTimeout(r, 10))

    const fallbackRouter = new OffloadRouter({
      localSelector,
      clusterDiscovery: emptyDiscovery,
      telemetryDeps: mockTelemetryDeps,
    })

    const fallbackResult = await fallbackRouter.classify(SIMPLE_REQUEST)
    assert.equal(fallbackResult, 'simple')
    const fallbackEvents = telemetryEvents.filter((e) => e.eventClass === 'OFFLOAD_FALLBACK')
    assert.ok(fallbackEvents.length >= 1, 'Should have at least 1 fallback on empty peer list')
    await emptyDiscovery.stop()

    // Step 2: Recovery path — peer appears
    telemetryEvents.length = 0
    const peerInfo: PeerInfo = {
      id: `127.0.0.1:${peerPort}`,
      host: '127.0.0.1',
      port: peerPort,
      healthy: true,
      lastSeen: Date.now(),
    }

    const recoveredDiscovery = new ClusterDiscovery(
      { pollIntervalMs: 600_000, sourceWorker: 'test' },
      { getPeers: async () => [peerInfo] },
    )
    await recoveredDiscovery.start()
    await new Promise((r) => setTimeout(r, 10))

    const recoveredRouter = new OffloadRouter({
      localSelector,
      clusterDiscovery: recoveredDiscovery,
      telemetryDeps: mockTelemetryDeps,
    })

    const recoveredResult = await recoveredRouter.classify(SIMPLE_REQUEST)
    assert.equal(recoveredResult, 'simple')

    const forwardedEvent = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_FORWARDED')
    assert.ok(forwardedEvent, 'Should re-offload to peer when peer becomes available')
    await recoveredDiscovery.stop()
  })

  // ── Telemetry Verification ──────────────────────────────────────

  it('emits structured telemetry with required fields on forward path', async () => {
    telemetryEvents.length = 0

    const localSelector = new HeuristicSelector()
    const peerInfo: PeerInfo = {
      id: `127.0.0.1:${peerPort}`,
      host: '127.0.0.1',
      port: peerPort,
      healthy: true,
      lastSeen: Date.now(),
    }

    const discovery = new ClusterDiscovery(
      { pollIntervalMs: 600_000, sourceWorker: 'test' },
      { getPeers: async () => [peerInfo] },
    )
    await discovery.start()
    await new Promise((r) => setTimeout(r, 10))

    const router = new OffloadRouter({
      localSelector,
      clusterDiscovery: discovery,
      telemetryDeps: mockTelemetryDeps,
    })

    await router.classify(SIMPLE_REQUEST)

    const decision = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_DECISION')
    assert.ok(decision, 'OFFLOAD_DECISION should be emitted')
    assert.ok(decision.payload.peerId, 'OFFLOAD_DECISION should have peerId')
    assert.ok(decision.payload.requestId, 'OFFLOAD_DECISION should have requestId')
    assert.equal(decision.payload.reason, 'peer_healthy')

    const forwarded = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_FORWARDED')
    assert.ok(forwarded, 'OFFLOAD_FORWARDED should be emitted')
    assert.ok(forwarded.payload.peerId, 'OFFLOAD_FORWARDED should have peerId')
    assert.ok(forwarded.payload.requestId, 'OFFLOAD_FORWARDED should have requestId')
    assert.ok(typeof forwarded.payload.latencyMs === 'number', 'OFFLOAD_FORWARDED should have latencyMs')
    assert.ok(forwarded.payload.classification, 'OFFLOAD_FORWARDED should have classification')

    await discovery.stop()
  })

  it('emits structured telemetry with required fields on fallback path', async () => {
    telemetryEvents.length = 0

    const localSelector = new HeuristicSelector()
    const discovery = new ClusterDiscovery(
      { pollIntervalMs: 600_000, sourceWorker: 'test' },
      { getPeers: async () => [] },
    )
    await discovery.start()
    await new Promise((r) => setTimeout(r, 10))

    const router = new OffloadRouter({
      localSelector,
      clusterDiscovery: discovery,
      telemetryDeps: mockTelemetryDeps,
    })

    await router.classify(SIMPLE_REQUEST)

    const decision = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_DECISION')
    assert.ok(decision, 'OFFLOAD_DECISION should be emitted')
    assert.equal(decision.payload.reason, 'no_healthy_peer')

    const fallback = telemetryEvents.find((e) => e.eventClass === 'OFFLOAD_FALLBACK')
    assert.ok(fallback, 'OFFLOAD_FALLBACK should be emitted')
    assert.ok(typeof fallback.payload.latencyMs === 'number', 'OFFLOAD_FALLBACK should have latencyMs')
    assert.ok(fallback.payload.classification, 'OFFLOAD_FALLBACK should have classification')

    await discovery.stop()
  })
})
