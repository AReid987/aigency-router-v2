import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// We mock bonjour-service by injecting a factory, so no module-level mock needed.

const { ClusterRegistry } = await import('./cluster-registry.ts')

// --- Mock helpers ---

interface MockBonjourService {
  name: string
  host: string
  port: number
  addresses?: string[]
}

interface MockBonjourInstance {
  published: Array<{ name: string; type: string; port: number }>
  browseCallback: ((service: MockBonjourService) => void) | null
  destroyed: boolean
  publish: (opts: { name: string; type: string; port: number }) => { stop: () => void }
  find: (opts: { type: string }, cb: (service: MockBonjourService) => void) => { stop: () => void }
  destroy: () => void
}

function createMockBonjour(): MockBonjourInstance {
  const mock: MockBonjourInstance = {
    published: [],
    browseCallback: null,
    destroyed: false,
    publish: (opts) => {
      mock.published.push(opts)
      return { stop: () => {} }
    },
    find: (_opts, cb) => {
      mock.browseCallback = cb
      return { stop: () => {} }
    },
    destroy: () => {
      mock.destroyed = true
    },
  }
  return mock
}

function makeFactory(mock: MockBonjourInstance) {
  return { create: () => mock as unknown as ReturnType<MockBonjourInstance['publish']> extends infer _ ? MockBonjourInstance : never } as { create: () => MockBonjourInstance }
}

describe('ClusterRegistry', () => {
  let telemetryCalls: Array<Record<string, unknown>>
  let mockTrigger: (target: string, fnName: string, input: unknown) => Promise<unknown>

  beforeEach(() => {
    telemetryCalls = []
    mockTrigger = async (_target: string, _fnName: string, input: unknown) => {
      telemetryCalls.push(input as Record<string, unknown>)
      return {}
    }
  })

  afterEach(async () => {
    // Ensure no lingering timers
  })

  it('start() publishes local service', async () => {
    const mockBonjour = createMockBonjour()
    const registry = new ClusterRegistry(
      { port: 4321, telemetryDeps: { trigger: mockTrigger }, sourceWorker: 'test' },
      makeFactory(mockBonjour),
    )

    await registry.start()

    assert.equal(mockBonjour.published.length, 1)
    assert.equal(mockBonjour.published[0].type, '_aigency-slm._tcp')
    assert.equal(mockBonjour.published[0].port, 4321)
    assert.match(mockBonjour.published[0].name, /^aigency-node-/)

    await registry.stop()
  })

  it('browse discovers mock service → getNodes() returns it, onNodeUp fires', async () => {
    const mockBonjour = createMockBonjour()
    const registry = new ClusterRegistry(
      { telemetryDeps: { trigger: mockTrigger }, sourceWorker: 'test' },
      makeFactory(mockBonjour),
    )

    const nodeUpCalls: Array<{ id: string; host: string; port: number }> = []
    registry.onNodeUp = (node) => nodeUpCalls.push(node)

    await registry.start()

    // Simulate Bonjour discovering a service
    mockBonjour.browseCallback!({
      name: 'remote-node-1',
      host: '192.168.1.10',
      port: 5555,
    })

    const nodes = registry.getNodes()
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].host, '192.168.1.10')
    assert.equal(nodes[0].port, 5555)
    assert.equal(nodes[0].id, '192.168.1.10:5555')

    assert.equal(nodeUpCalls.length, 1)
    assert.equal(nodeUpCalls[0].host, '192.168.1.10')

    // Telemetry emitted
    const clusterEvent = telemetryCalls.find((e) => e.eventClass === 'CLUSTER_NODE_DISCOVERED')
    assert.ok(clusterEvent, 'Should emit CLUSTER_NODE_DISCOVERED telemetry')
    assert.equal((clusterEvent!.payload as Record<string, unknown>).nodeId, '192.168.1.10:5555')

    await registry.stop()
  })

  it('stale node auto-removed after threshold → getNodes() removes it, onNodeDown fires', async () => {
    const mockBonjour = createMockBonjour()
    // Use short intervals for test speed
    const registry = new ClusterRegistry(
      {
        telemetryDeps: { trigger: mockTrigger },
        sourceWorker: 'test',
        healthCheckIntervalMs: 50,
        staleThresholdMs: 100,
      },
      makeFactory(mockBonjour),
    )

    const nodeDownCalls: Array<{ id: string; host: string; port: number }> = []
    registry.onNodeDown = (node) => nodeDownCalls.push(node)

    await registry.start()

    // Simulate discovery
    mockBonjour.browseCallback!({
      name: 'stale-node',
      host: '10.0.0.5',
      port: 7777,
    })

    assert.equal(registry.getNodes().length, 1)

    // Wait for the health check to prune the stale node
    // staleThresholdMs=100, healthCheckIntervalMs=50 → should be removed after ~150ms
    await new Promise((resolve) => setTimeout(resolve, 250))

    assert.equal(registry.getNodes().length, 0)
    assert.equal(nodeDownCalls.length, 1)
    assert.equal(nodeDownCalls[0].host, '10.0.0.5')

    // Telemetry emitted
    const lostEvent = telemetryCalls.find((e) => e.eventClass === 'CLUSTER_NODE_LOST')
    assert.ok(lostEvent, 'Should emit CLUSTER_NODE_LOST telemetry')
    assert.equal((lostEvent!.payload as Record<string, unknown>).reason, 'stale')

    await registry.stop()
  })

  it('stop() cleans up — stops publishing, browsing, and destroys bonjour', async () => {
    const mockBonjour = createMockBonjour()
    const registry = new ClusterRegistry(
      {},
      makeFactory(mockBonjour),
    )

    await registry.start()
    assert.equal(mockBonjour.destroyed, false)

    await registry.stop()
    assert.equal(mockBonjour.destroyed, true)
    assert.equal(registry.getNodes().length, 0)
  })

  it('duplicate node discovery updates lastSeen without re-firing onNodeUp', async () => {
    const mockBonjour = createMockBonjour()
    const registry = new ClusterRegistry(
      {},
      makeFactory(mockBonjour),
    )

    const nodeUpCalls: Array<{ id: string }> = []
    registry.onNodeUp = (node) => nodeUpCalls.push(node)

    await registry.start()

    // First discovery
    mockBonjour.browseCallback!({ name: 'n1', host: '1.2.3.4', port: 1000 })
    // Second call for same node (Bonjour re-announces periodically)
    mockBonjour.browseCallback!({ name: 'n1', host: '1.2.3.4', port: 1000 })

    assert.equal(nodeUpCalls.length, 1, 'onNodeUp should fire only once per unique node')
    assert.equal(registry.getNodes().length, 1)

    await registry.stop()
  })
})
