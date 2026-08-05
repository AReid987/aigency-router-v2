/**
 * ClusterDiscovery unit tests.
 *
 * Uses an injectable mock TailscaleTransport to verify peer discovery,
 * health transitions, event emission, deduplication, lifecycle cleanup,
 * and telemetry integration without requiring a real Tailscale daemon.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PeerInfo, TailscaleTransport } from './cluster-discovery.ts'

const { ClusterDiscovery } = await import('./cluster-discovery.ts')

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Minimal peer shape used to configure the mock transport. */
interface MockPeer {
  id: string
  host: string
  port: number
  healthy: boolean
}

/** Build a controllable mock TailscaleTransport. */
function createMockTransport(): {
  transport: TailscaleTransport
  setPeers: (peers: MockPeer[]) => void
  getCallCount: () => number
} {
  let peers: MockPeer[] = []
  let callCount = 0

  return {
    transport: {
      getPeers: async () => {
        callCount++
        return peers.map((p) => ({
          ...p,
          lastSeen: Date.now(),
        }))
      },
    },
    setPeers: (newPeers: MockPeer[]) => {
      peers = [...newPeers]
    },
    getCallCount: () => callCount,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Test poll interval — short enough for fast tests, long enough to avoid
// race conditions on a busy event loop.
const POLL_MS = 100
const WAIT_MS = 200 // comfortably > 1 interval

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClusterDiscovery', () => {
  let telemetryCalls: Array<Record<string, unknown>>
  let mockTrigger: (target: string, fnName: string, input: unknown) => Promise<unknown>

  beforeEach(() => {
    telemetryCalls = []
    mockTrigger = async (
      _target: string,
      _fnName: string,
      input: unknown,
    ) => {
      telemetryCalls.push(input as Record<string, unknown>)
      return {}
    }
  })

  // ---- Scenario 1: initial discovery ------------------------------------

  it('1: configured peer appears in getPeers() within configured interval', async () => {
    const { transport, setPeers } = createMockTransport()
    setPeers([
      { id: 'node-1', host: '100.64.0.1', port: 8080, healthy: true },
    ])

    const discovery = new ClusterDiscovery(
      {
        pollIntervalMs: POLL_MS,
        telemetryDeps: { trigger: mockTrigger },
        sourceWorker: 'test',
      },
      transport,
    )

    // start() performs an immediate poll, so the peer should be visible
    // right after resolve.
    await discovery.start()

    const peers = discovery.getPeers()
    assert.equal(peers.length, 1)
    assert.equal(peers[0].id, 'node-1')
    assert.equal(peers[0].host, '100.64.0.1')
    assert.equal(peers[0].port, 8080)
    assert.equal(peers[0].healthy, true)
    assert.ok(typeof peers[0].lastSeen === 'number')

    await discovery.stop()
  })

  // ---- Scenario 2: nodeUp fires on new peer -----------------------------

  it('2: nodeUp fires when peer is discovered (new peer)', async () => {
    const { transport, setPeers } = createMockTransport()
    const discovery = new ClusterDiscovery(
      {
        pollIntervalMs: POLL_MS,
        telemetryDeps: { trigger: mockTrigger },
        sourceWorker: 'test',
      },
      transport,
    )

    const nodeUpPeers: PeerInfo[] = []
    discovery.onNodeUp = (p) => nodeUpPeers.push(p)

    // Start with no peers — onNodeUp should not fire
    await discovery.start()
    assert.equal(nodeUpPeers.length, 0)

    // Add a peer on the next poll
    setPeers([
      { id: 'node-2', host: '100.64.0.2', port: 8081, healthy: true },
    ])
    await delay(WAIT_MS)

    assert.equal(nodeUpPeers.length, 1)
    assert.equal(nodeUpPeers[0].id, 'node-2')
    assert.equal(nodeUpPeers[0].host, '100.64.0.2')

    // Telemetry verification
    const discoveredEvent = telemetryCalls.find(
      (e) => e.eventClass === 'CLUSTER_NODE_DISCOVERED',
    )
    assert.ok(discoveredEvent, 'CLUSTER_NODE_DISCOVERED telemetry emitted')
    const payload = discoveredEvent!.payload as Record<string, unknown>
    assert.equal(payload.nodeId, 'node-2')
    assert.equal(payload.host, '100.64.0.2')

    // nodeDown should NOT have fired
    const lostEvent = telemetryCalls.find(
      (e) => e.eventClass === 'CLUSTER_NODE_LOST',
    )
    assert.equal(lostEvent, undefined, 'No CLUSTER_NODE_LOST during discovery')

    await discovery.stop()
  })

  // ---- Scenario 3: nodeDown fires on peer removal -----------------------

  it('3: nodeDown fires when peer is removed (disappears from transport)', async () => {
    const { transport, setPeers } = createMockTransport()
    setPeers([
      { id: 'node-3', host: '100.64.0.3', port: 8082, healthy: true },
    ])

    const discovery = new ClusterDiscovery(
      {
        pollIntervalMs: POLL_MS,
        telemetryDeps: { trigger: mockTrigger },
        sourceWorker: 'test',
      },
      transport,
    )

    const nodeDownPeers: PeerInfo[] = []
    discovery.onNodeDown = (p) => nodeDownPeers.push(p)

    await discovery.start()
    assert.equal(discovery.getPeers().length, 1)

    // Remove the peer from the transport
    setPeers([])
    await delay(WAIT_MS)

    assert.equal(nodeDownPeers.length, 1, 'nodeDown should fire once')
    assert.equal(nodeDownPeers[0].id, 'node-3')
    assert.equal(discovery.getPeers().length, 0, 'peer removed from map')

    // Telemetry verification
    const lostEvent = telemetryCalls.find(
      (e) => e.eventClass === 'CLUSTER_NODE_LOST',
    )
    assert.ok(lostEvent, 'CLUSTER_NODE_LOST telemetry emitted')
    const payload = lostEvent!.payload as Record<string, unknown>
    assert.equal(payload.nodeId, 'node-3')
    assert.equal(payload.reason, 'disappeared')

    await discovery.stop()
  })

  // ---- Scenario 4: no duplicate nodeUp ----------------------------------

  it('4: nodeUp does NOT fire again for already-known peer (no spam)', async () => {
    const { transport, setPeers } = createMockTransport()
    setPeers([
      { id: 'node-4', host: '100.64.0.4', port: 8083, healthy: true },
    ])

    const discovery = new ClusterDiscovery(
      { pollIntervalMs: POLL_MS },
      transport,
    )

    const nodeUpPeers: PeerInfo[] = []
    discovery.onNodeUp = (p) => nodeUpPeers.push(p)

    await discovery.start()
    assert.equal(nodeUpPeers.length, 1, 'nodeUp fires on initial discovery')

    // Return the same peer on the next poll (simulates re-announce)
    setPeers([
      { id: 'node-4', host: '100.64.0.4', port: 8083, healthy: true },
    ])
    await delay(WAIT_MS)

    assert.equal(
      nodeUpPeers.length,
      1,
      'nodeUp should NOT fire again for the same peer',
    )
    assert.equal(discovery.getPeers().length, 1)

    await discovery.stop()
  })

  // ---- Scenario 5: stop() lifecycle cleanup -----------------------------

  it('5: stop() clears timers and listeners (no events after stop)', async () => {
    const { transport, setPeers } = createMockTransport()
    setPeers([
      { id: 'node-5', host: '100.64.0.5', port: 8084, healthy: true },
    ])

    const discovery = new ClusterDiscovery(
      { pollIntervalMs: POLL_MS },
      transport,
    )

    const nodeDownPeers: PeerInfo[] = []
    discovery.onNodeDown = (p) => nodeDownPeers.push(p)

    await discovery.start()
    assert.equal(discovery.getPeers().length, 1)

    // Stop discovery
    await discovery.stop()

    // After stop, changing transport data should not trigger anything
    setPeers([])
    await delay(WAIT_MS)

    assert.equal(nodeDownPeers.length, 0, 'no nodeDown after stop')
    assert.equal(
      discovery.getPeers().length,
      0,
      'stop() clears the peer map',
    )

    // All EventEmitter listeners should be removed
    assert.equal(discovery.listenerCount('nodeUp'), 0)
    assert.equal(discovery.listenerCount('nodeDown'), 0)
  })

  // ---- Scenario 6: injected transport call tracking ---------------------

  it('6: injectable transport is called at expected intervals', async () => {
    const { transport, setPeers, getCallCount } = createMockTransport()
    setPeers([
      { id: 'node-6', host: '100.64.0.6', port: 8085, healthy: true },
    ])

    const discovery = new ClusterDiscovery(
      { pollIntervalMs: POLL_MS },
      transport,
    )

    // Before start, no calls
    assert.equal(getCallCount(), 0)

    await discovery.start()

    // start() polls once immediately
    assert.equal(getCallCount(), 1, 'initial poll on start()')

    // Wait for several interval polls
    await delay(POLL_MS * 3 + 50)

    // Should have been called at least 4 times (initial + 3 intervals)
    const calls = getCallCount()
    assert.ok(
      calls >= 4,
      `expected >= 4 transport calls, got ${calls}`,
    )

    await discovery.stop()
  })
})
