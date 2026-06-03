import { registerWorker, type ISdk } from 'iii-sdk'
import { VaultManager } from './vault.ts'

const ENGINE_URL = process.env.III_URL ?? 'ws://127.0.0.1:49134'
const DB_PATH = process.env.VAULT_DB_PATH ?? 'data/vault.db'

// Singleton VaultManager — unlocked once, reused for all operations
let vaultManager: VaultManager | null = null

function getOrCreateVault(password: string): VaultManager {
  if (!vaultManager) {
    vaultManager = new VaultManager(DB_PATH)
    vaultManager.unlock(password)
    vaultManager.storeCanary()
  }
  return vaultManager
}

export function createVaultWorker(url: string = ENGINE_URL, masterPassword?: string): ISdk {
  const iii = registerWorker(url, { workerName: 'vault' })

  // If a master password is provided, unlock immediately
  if (masterPassword) {
    getOrCreateVault(masterPassword)
  }

  iii.registerFunction('vault::status', async () => {
    if (!vaultManager) {
      return { worker: 'vault', status: 'locked', unlocked: false, keyCount: 0, providers: [] }
    }
    const status = vaultManager.getStatus()
    return { worker: 'vault', status: 'healthy', uptime: process.uptime(), ...status }
  })

  iii.registerFunction('vault::store', async (input: { providerId: string; apiKey: string; virtualColleagueId?: string }) => {
    if (!vaultManager) {
      return { error: 'Vault is locked — unlock first', stored: false }
    }
    try {
      const result = vaultManager.storeKey(input.providerId, input.apiKey, input.virtualColleagueId ?? null)
      return { ...result, worker: 'vault' }
    } catch (err: any) {
      return { error: err.message, stored: false }
    }
  })

  iii.registerFunction('vault::retrieve', async (input: { providerId: string }) => {
    if (!vaultManager) {
      return { error: 'Vault is locked — unlock first', key: null }
    }
    try {
      const result = vaultManager.getKey(input.providerId)
      if (!result) {
        return { key: null, worker: 'vault', note: 'Key not found for provider' }
      }
      return { ...result, worker: 'vault' }
    } catch (err: any) {
      return { error: err.message, key: null }
    }
  })

  iii.registerFunction('vault::lock', async () => {
    if (!vaultManager) {
      return { locked: true, note: 'Already locked' }
    }
    vaultManager.lock()
    vaultManager = null
    return { locked: true, worker: 'vault' }
  })

  return iii
}

export { VaultManager } from './vault.js'

// Start if run directly — prompt for master password
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  const envPassword = process.env.VAULT_MASTER_KEY
  if (envPassword) {
    startWorker(envPassword)
  } else {
    // Prompt via readline
    import('node:readline').then(({ createInterface }) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      rl.question('[vault] Enter master password: ', (password: string) => {
        rl.close()
        if (!password) {
          console.error('[vault] Master password required. Set VAULT_MASTER_KEY env var or enter at prompt.')
          process.exit(1)
        }
        startWorker(password)
      })
    })
  }
}

function startWorker(masterPassword: string): void {
  const iii = createVaultWorker(ENGINE_URL, masterPassword)
  console.log('[vault] Worker registered — listening on', ENGINE_URL)
  console.log('[vault] Vault unlocked, DB:', DB_PATH)

  process.on('SIGTERM', async () => {
    if (vaultManager) vaultManager.lock()
    await iii.shutdown()
    process.exit(0)
  })
}
