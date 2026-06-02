import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('engram worker module', () => {
  it('exports createEngramWorker function', async () => {
    const { createEngramWorker } = await import('./index.ts')
    assert.equal(typeof createEngramWorker, 'function')
  })

  it('createEngramWorker is callable', async () => {
    const { createEngramWorker } = await import('./index.ts')
    assert.ok(createEngramWorker instanceof Function)
  })
})
