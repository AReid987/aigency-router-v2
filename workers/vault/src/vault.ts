import { randomUUID } from 'node:crypto'
import { encrypt, decrypt, type EncryptedPayload } from './crypto.ts'
import { SugarVaultDB, type VaultEntry } from './db.ts'

/**
 * VaultManager — orchestrates crypto + DB for the SugarVault.
 * Holds the derived encryption key in memory only when unlocked.
 */
export class VaultManager {
  private db: SugarVaultDB | null = null
  private masterPassword: string | null = null
  private unlocked = false
  private readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  /** Unlock the vault with the master password. Derives key and opens DB. */
  unlock(masterPassword: string): { unlocked: true } {
    if (!masterPassword) {
      throw new Error('Master password must not be empty')
    }
    // Validate password by encrypting + decrypting a canary
    // This ensures the password works before we commit
    try {
      this.db = new SugarVaultDB(this.dbPath)
      this.masterPassword = masterPassword
      this.unlocked = true

      // Verify password against stored canary if one exists
      const canary = this.db.getMeta('password_canary')
      if (canary) {
        const payload = deserializePayload(Buffer.from(canary, 'base64'))
        decrypt(payload, masterPassword)
      }

      logOp('unlock', { success: true })
      return { unlocked: true }
    } catch (err) {
      this.lock()
      logOp('unlock', { success: false, error: 'wrong password' })
      throw new Error('Unlock failed: wrong master password')
    }
  }

  /** Store an API key — encrypts and inserts into DB. */
  storeKey(
    providerId: string,
    apiKey: string,
    virtualColleagueId: string | null = null
  ): { stored: true; id: string } {
    this.ensureUnlocked()
    if (!providerId) throw new Error('providerId must not be empty')
    if (!apiKey) throw new Error('apiKey must not be empty')

    const id = randomUUID()
    const payload = encrypt(apiKey, this.masterPassword!)
    const serialized = serializePayload(payload)

    this.db!.storeKey(id, providerId, serialized, virtualColleagueId)
    logOp('store', { id, provider: providerId, success: true })
    return { stored: true, id }
  }

  /** Retrieve and decrypt an API key by provider ID. */
  getKey(providerId: string): { key: string } | null {
    this.ensureUnlocked()
    if (!providerId) throw new Error('providerId must not be empty')

    const entry = this.db!.getKey(providerId)
    if (!entry) {
      logOp('retrieve', { provider: providerId, success: false, error: 'not found' })
      return null
    }

    try {
      const payload = deserializePayload(entry.encryptedPayload)
      const key = decrypt(payload, this.masterPassword!)
      logOp('retrieve', { id: entry.id, provider: providerId, success: true })
      return { key }
    } catch (err) {
      logOp('retrieve', { id: entry.id, provider: providerId, success: false, error: 'decrypt failed' })
      return null
    }
  }

  /** Return vault status — key count, unlock state, provider list. */
  getStatus(): { unlocked: boolean; keyCount: number; providers: string[]; lastOperation?: string } {
    if (!this.unlocked || !this.db) {
      return { unlocked: false, keyCount: 0, providers: [] }
    }
    const allKeys = this.db.getAllKeys()
    const providers = [...new Set(allKeys.map((k) => k.providerId))]
    const lastOp = this.db.getMeta('last_operation')
    return { unlocked: true, keyCount: this.db.getKeyCount(), providers, lastOperation: lastOp ?? undefined }
  }

  /** Lock the vault — clears derived key from memory, closes DB. */
  lock(): void {
    this.masterPassword = null
    this.unlocked = false
    if (this.db) {
      this.db.close()
      this.db = null
    }
    logOp('lock', { success: true })
  }

  /** Store a password canary for future unlock verification. */
  storeCanary(): void {
    this.ensureUnlocked()
    const canary = encrypt('vault-canary-check', this.masterPassword!)
    this.db!.setMeta('password_canary', serializePayload(canary).toString('base64'))
  }

  private ensureUnlocked(): void {
    if (!this.unlocked || !this.db || !this.masterPassword) {
      throw new Error('Vault is locked — call unlock() first')
    }
  }
}

// --- Payload serialization ---
// Fixed-size components: salt(16) + iv(12) + authTag(16) + variable ciphertext

function serializePayload(payload: EncryptedPayload): Buffer {
  return Buffer.concat([payload.salt, payload.iv, payload.authTag, payload.ciphertext])
}

function deserializePayload(buf: Buffer): EncryptedPayload {
  return {
    salt: buf.subarray(0, 16),
    iv: buf.subarray(16, 28),
    authTag: buf.subarray(28, 44),
    ciphertext: buf.subarray(44),
  }
}

// --- Structured logging ---
// Logs key ID, provider, operation type, success/failure, timestamp.
// NEVER logs secret values.

function logOp(op: string, meta: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    component: 'vault',
    op,
    ...meta,
  }
  console.log(JSON.stringify(entry))
}
