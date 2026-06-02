import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('vault worker module', () => {
  it('exports createVaultWorker function', async () => {
    const { createVaultWorker } = await import('./index.ts')
    assert.equal(typeof createVaultWorker, 'function')
  })

  it('createVaultWorker is callable', async () => {
    const { createVaultWorker } = await import('./index.ts')
    assert.ok(createVaultWorker instanceof Function)
  })
})
