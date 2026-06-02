import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('translator worker module', () => {
  it('exports createTranslatorWorker function', async () => {
    const { createTranslatorWorker } = await import('./index.ts')
    assert.equal(typeof createTranslatorWorker, 'function')
  })

  it('createTranslatorWorker is callable', async () => {
    const { createTranslatorWorker } = await import('./index.ts')
    assert.ok(createTranslatorWorker instanceof Function)
  })
})
