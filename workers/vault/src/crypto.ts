import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

/**
 * AES-256-GCM encryption module for SugarVault.
 * Uses scrypt for key derivation and AES-256-GCM for authenticated encryption.
 * No external dependencies — Node.js built-in crypto only.
 */

export interface EncryptedPayload {
  /** Random salt used for key derivation (16 bytes) */
  salt: Buffer
  /** Random initialization vector (12 bytes) */
  iv: Buffer
  /** GCM authentication tag (16 bytes) */
  authTag: Buffer
  /** Encrypted ciphertext */
  ciphertext: Buffer
}

const SCRYPT_KEYLEN = 32 // 256 bits for AES-256
const SALT_BYTES = 16
const IV_BYTES = 12 // GCM standard nonce size
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/**
 * Derive a 256-bit key from a master password and salt using scrypt.
 */
export function deriveKey(masterPassword: string, salt: Buffer): Buffer {
  if (!masterPassword) {
    throw new Error('masterPassword must not be empty')
  }
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES) {
    throw new Error(`salt must be a ${SALT_BYTES}-byte Buffer`)
  }
  return scryptSync(masterPassword, salt, SCRYPT_KEYLEN, SCRYPT_OPTS)
}

/**
 * Encrypt plaintext with AES-256-GCM using a master password.
 * Generates a random salt and IV for each encryption, ensuring
 * identical plaintexts produce different ciphertexts.
 */
export function encrypt(plaintext: string, masterPassword: string): EncryptedPayload {
  if (typeof plaintext !== 'string') {
    throw new Error('plaintext must be a string')
  }
  if (!masterPassword) {
    throw new Error('masterPassword must not be empty')
  }

  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(masterPassword, salt)

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return { salt, iv, authTag, ciphertext }
}

/**
 * Decrypt an AES-256-GCM encrypted payload using the master password.
 * Throws if the password is wrong or the ciphertext has been tampered with.
 */
export function decrypt(payload: EncryptedPayload, masterPassword: string): string {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload must be an EncryptedPayload object')
  }
  if (!Buffer.isBuffer(payload.salt) || payload.salt.length !== SALT_BYTES) {
    throw new Error(`payload.salt must be a ${SALT_BYTES}-byte Buffer`)
  }
  if (!Buffer.isBuffer(payload.iv) || payload.iv.length !== IV_BYTES) {
    throw new Error(`payload.iv must be a ${IV_BYTES}-byte Buffer`)
  }
  if (!Buffer.isBuffer(payload.authTag) || payload.authTag.length !== 16) {
    throw new Error('payload.authTag must be a 16-byte Buffer')
  }
  if (!Buffer.isBuffer(payload.ciphertext)) {
    throw new Error('payload.ciphertext must be a Buffer')
  }
  if (!masterPassword) {
    throw new Error('masterPassword must not be empty')
  }

  const key = deriveKey(masterPassword, payload.salt)

  const decipher = createDecipheriv('aes-256-gcm', key, payload.iv)
  decipher.setAuthTag(payload.authTag)

  try {
    const plaintext = Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(),
    ])
    return plaintext.toString('utf8')
  } catch (err) {
    // AES-GCM final() throws if the auth tag doesn't match
    throw new Error('Decryption failed: authentication tag mismatch (wrong password or tampered data)')
  }
}
