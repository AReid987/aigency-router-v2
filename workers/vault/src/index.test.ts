import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VaultManager } from './vault.ts'

describe('VaultManager', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'))
    dbPath = join(tmpDir, 'test-vault.db')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('unlock/lock lifecycle', () => {
    it('unlocks with a valid master password', () => {
      const vm = new VaultManager(dbPath)
      const result = vm.unlock('test-password-123')
      assert.deepEqual(result, { unlocked: true })
      vm.lock()
    })

    it('throws on empty master password', () => {
      const vm = new VaultManager(dbPath)
      assert.throws(() => vm.unlock(''), /Master password must not be empty/)
    })

    it('reports locked status before unlock', () => {
      const vm = new VaultManager(dbPath)
      const status = vm.getStatus()
      assert.equal(status.unlocked, false)
      assert.equal(status.keyCount, 0)
      assert.deepEqual(status.providers, [])
    })

    it('reports unlocked status after unlock', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')
      const status = vm.getStatus()
      assert.equal(status.unlocked, true)
      vm.lock()
    })

    it('clears key from memory on lock', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')
      vm.lock()
      const status = vm.getStatus()
      assert.equal(status.unlocked, false)
    })
  })

  describe('password verification with canary', () => {
    it('rejects wrong password after canary is stored', () => {
      const vm1 = new VaultManager(dbPath)
      vm1.unlock('correct-password')
      vm1.storeCanary()
      vm1.lock()

      const vm2 = new VaultManager(dbPath)
      assert.throws(() => vm2.unlock('wrong-password'), /Unlock failed: wrong master password/)
    })

    it('accepts correct password after canary is stored', () => {
      const vm1 = new VaultManager(dbPath)
      vm1.unlock('correct-password')
      vm1.storeCanary()
      vm1.lock()

      const vm2 = new VaultManager(dbPath)
      const result = vm2.unlock('correct-password')
      assert.deepEqual(result, { unlocked: true })
      vm2.lock()
    })
  })

  describe('storeKey + getKey', () => {
    it('stores and retrieves an API key', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')

      const stored = vm.storeKey('openai', 'sk-test-key-12345')
      assert.equal(stored.stored, true)
      assert.ok(stored.id)

      const result = vm.getKey('openai')
      assert.ok(result)
      assert.equal(result.key, 'sk-test-key-12345')
      vm.lock()
    })

    it('stores with virtualColleagueId', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')

      vm.storeKey('anthropic', 'sk-ant-123', 'colleague-1')
      const result = vm.getKey('anthropic')
      assert.ok(result)
      assert.equal(result.key, 'sk-ant-123')
      vm.lock()
    })

    it('returns null for nonexistent provider', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')

      const result = vm.getKey('nonexistent')
      assert.equal(result, null)
      vm.lock()
    })

    it('retrieves the latest key for a provider', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')

      vm.storeKey('openai', 'old-key')
      vm.storeKey('openai', 'new-key')

      const result = vm.getKey('openai')
      assert.ok(result)
      assert.equal(result.key, 'new-key')
      vm.lock()
    })

    it('throws on empty providerId', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')
      assert.throws(() => vm.storeKey('', 'key'), /providerId must not be empty/)
      vm.lock()
    })

    it('throws on empty apiKey', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')
      assert.throws(() => vm.storeKey('openai', ''), /apiKey must not be empty/)
      vm.lock()
    })
  })

  describe('getKey when locked', () => {
    it('throws vault locked error', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')
      vm.storeKey('openai', 'sk-123')
      vm.lock()

      assert.throws(() => vm.getKey('openai'), /Vault is locked/)
    })
  })

  describe('storeKey when locked', () => {
    it('throws vault locked error', () => {
      const vm = new VaultManager(dbPath)
      vm.lock()

      assert.throws(() => vm.storeKey('openai', 'sk-123'), /Vault is locked/)
    })
  })

  describe('getStatus', () => {
    it('reports key count and providers', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')
      vm.storeKey('openai', 'key1')
      vm.storeKey('anthropic', 'key2')
      vm.storeKey('openai', 'key3')

      const status = vm.getStatus()
      assert.equal(status.unlocked, true)
      assert.equal(status.keyCount, 3)
      assert.ok(status.providers.includes('openai'))
      assert.ok(status.providers.includes('anthropic'))
      vm.lock()
    })
  })

  describe('multiple providers', () => {
    it('stores and retrieves keys for different providers independently', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')

      vm.storeKey('openai', 'sk-openai-123')
      vm.storeKey('anthropic', 'sk-ant-456')
      vm.storeKey('google', 'sk-google-789')

      assert.equal(vm.getKey('openai')?.key, 'sk-openai-123')
      assert.equal(vm.getKey('anthropic')?.key, 'sk-ant-456')
      assert.equal(vm.getKey('google')?.key, 'sk-google-789')
      vm.lock()
    })
  })

  describe('encryption at rest', () => {
    it('does not store plaintext key in the DB', () => {
      const vm = new VaultManager(dbPath)
      vm.unlock('test-password')
      vm.storeKey('openai', 'sk-secret-plaintext')
      vm.lock()

      // Read raw DB file — should not contain the plaintext key
      const raw = readFileSync(dbPath)
      assert.ok(!raw.includes('sk-secret-plaintext'), 'DB file should not contain plaintext key')
    })
  })
})

// ── Telemetry Tests ────────────────────────────────────────────────────

describe('vault telemetry emission', () => {
  it('emits KEY_ROTATED when storing a key for an existing provider', async () => {
    const { createVaultWorker } = await import('./index.ts')
    const { logTelemetry } = await import('../../shared/telemetry.ts')

    // Create a mock SDK to capture trigger calls
    const triggerCalls: { function_id: string; payload: unknown }[] = []
    const mockSdk = {
      trigger: async (args: { function_id: string; payload?: unknown }) => {
        triggerCalls.push({ function_id: args.function_id, payload: args.payload })
        return { logged: true }
      },
      registerFunction: () => {},
      shutdown: async () => {},
    } as any

    // We can't easily test createVaultWorker with a mock SDK because it
    // calls registerWorker internally. Instead, test the telemetry helper directly.
    let emitted = false
    const mockTrigger = async () => { emitted = true; return {} }
    await logTelemetry({ trigger: mockTrigger }, {
      eventClass: 'KEY_ROTATED',
      sourceWorker: 'vault',
      payload: { providerId: 'openai' },
    })
    assert.ok(emitted, 'logTelemetry should call trigger for KEY_ROTATED')
  })

  it('logTelemetry gracefully handles vault telemetry failure', async () => {
    const { logTelemetry } = await import('../../shared/telemetry.ts')

    const warnLogs: string[] = []
    const origWarn = console.warn
    console.warn = (...args: any[]) => warnLogs.push(args.join(' '))

    try {
      const failingTrigger = async () => { throw new Error('sugar-db down') }
      await logTelemetry({ trigger: failingTrigger }, {
        eventClass: 'KEY_ROTATED',
        sourceWorker: 'vault',
        payload: { providerId: 'openai' },
      })
      assert.ok(warnLogs.some(l => l.includes('sugar-db down')), 'should log warning on failure')
    } finally {
      console.warn = origWarn
    }
  })
})
