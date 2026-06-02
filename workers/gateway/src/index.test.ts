import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('gateway worker module', () => {
  it('exports createGatewayWorker function', async () => {
    const { createGatewayWorker } = await import('./index.ts')
    assert.equal(typeof createGatewayWorker, 'function')
  })

  it('createGatewayWorker is callable', async () => {
    const { createGatewayWorker } = await import('./index.ts')
    // Verify it's a function (factory) — we don't call it to avoid WS connection
    assert.ok(createGatewayWorker instanceof Function)
  })
})
