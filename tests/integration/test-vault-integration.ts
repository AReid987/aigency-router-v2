/**
 * Vault integration tests — TypeScript side.
 *
 * Verifies end-to-end vault operations via iii:
 *   1. vault::store — encrypt and store an API key
 *   2. vault::retrieve — decrypt and return the API key
 *   3. vault::status — report key count and unlock state
 *   4. vault::lock — lock the vault
 *
 * Prerequisites: iii engine + vault worker must be running.
 * Run: npx tsx tests/integration/test-vault-integration.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerWorker } from 'iii-sdk'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'
const TEST_PROVIDER = 'test-integration-provider'
const TEST_API_KEY = 'sk-test-integration-abcdef1234567890'

let iii: ReturnType<typeof registerWorker>

before(async () => {
  iii = registerWorker(ENGINE_URL, { workerName: 'integration-test-vault' })
  await new Promise((r) => setTimeout(r, 500))
})

after(async () => {
  await iii.shutdown()
})

describe('Vault integration (via iii)', () => {
  it('vault::store — should encrypt and store an API key', async () => {
    const result = await iii.trigger<
      { providerId: string; apiKey: string },
      { stored: boolean; id: string; worker: string }
    >({
      function_id: 'vault::store',
      payload: {
        providerId: TEST_PROVIDER,
        apiKey: TEST_API_KEY,
      },
      timeoutMs: 5000,
    })

    assert.ok(result, 'result should not be null')
    assert.equal(result.stored, true, 'stored should be true')
    assert.ok(result.id, 'should return an id')
    assert.equal(result.worker, 'vault')
  })

  it('vault::retrieve — should decrypt and return the correct key', async () => {
    const result = await iii.trigger<
      { providerId: string },
      { key: string; worker: string }
    >({
      function_id: 'vault::retrieve',
      payload: { providerId: TEST_PROVIDER },
      timeoutMs: 5000,
    })

    assert.ok(result, 'result should not be null')
    assert.equal(result.key, TEST_API_KEY, 'decrypted key should match original')
    assert.equal(result.worker, 'vault')
  })

  it('vault::status — should report key count and unlocked state', async () => {
    const result = await iii.trigger<
      Record<string, never>,
      { worker: string; status: string; unlocked: boolean; keyCount: number; providers: string[] }
    >({
      function_id: 'vault::status',
      payload: {},
      timeoutMs: 5000,
    })

    assert.ok(result, 'result should not be null')
    assert.equal(result.worker, 'vault')
    assert.equal(result.unlocked, true, 'vault should be unlocked')
    assert.ok(result.keyCount >= 1, 'should have at least 1 key')
    assert.ok(Array.isArray(result.providers), 'providers should be an array')
  })

  it('vault::lock — should lock the vault', async () => {
    const result = await iii.trigger<
      Record<string, never>,
      { locked: boolean; worker: string }
    >({
      function_id: 'vault::lock',
      payload: {},
      timeoutMs: 5000,
    })

    assert.ok(result, 'result should not be null')
    assert.equal(result.locked, true, 'vault should be locked')
    assert.equal(result.worker, 'vault')
  })
})
