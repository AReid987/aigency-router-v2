import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveKey, encrypt, decrypt, type EncryptedPayload } from './crypto.ts'

describe('crypto', () => {
  const PASSWORD = 'test-master-password-2024'
  const SAMPLE_KEY = 'sk-abc123def456ghi789jkl012mno345pqr678'

  describe('deriveKey', () => {
    it('returns a 32-byte buffer', () => {
      const salt = Buffer.alloc(16, 0x01)
      const key = deriveKey(PASSWORD, salt)
      assert.equal(key.length, 32)
      assert.ok(Buffer.isBuffer(key))
    })

    it('throws on empty password', () => {
      const salt = Buffer.alloc(16, 0x01)
      assert.throws(() => deriveKey('', salt), /must not be empty/)
    })

    it('throws on invalid salt', () => {
      assert.throws(() => deriveKey(PASSWORD, Buffer.alloc(8)), /16-byte Buffer/)
    })
  })

  describe('encrypt', () => {
    it('returns all four payload fields as Buffers', () => {
      const result = encrypt(SAMPLE_KEY, PASSWORD)
      assert.ok(Buffer.isBuffer(result.salt))
      assert.ok(Buffer.isBuffer(result.iv))
      assert.ok(Buffer.isBuffer(result.authTag))
      assert.ok(Buffer.isBuffer(result.ciphertext))
      assert.equal(result.salt.length, 16)
      assert.equal(result.iv.length, 12)
      assert.equal(result.authTag.length, 16)
    })

    it('throws on non-string plaintext', () => {
      assert.throws(() => encrypt(null as any, PASSWORD), /plaintext must be a string/)
    })

    it('throws on empty password', () => {
      assert.throws(() => encrypt(SAMPLE_KEY, ''), /must not be empty/)
    })
  })

  describe('decrypt', () => {
    it('throws on invalid payload', () => {
      assert.throws(() => decrypt(null as any, PASSWORD), /payload must be an EncryptedPayload/)
    })

    it('throws on wrong password', () => {
      const payload = encrypt(SAMPLE_KEY, PASSWORD)
      assert.throws(() => decrypt(payload, 'wrong-password'), /authentication tag mismatch/)
    })

    it('throws on empty password', () => {
      const payload = encrypt(SAMPLE_KEY, PASSWORD)
      assert.throws(() => decrypt(payload, ''), /must not be empty/)
    })
  })

  describe('round-trip', () => {
    it('encrypt then decrypt returns original plaintext', () => {
      const payload = encrypt(SAMPLE_KEY, PASSWORD)
      const result = decrypt(payload, PASSWORD)
      assert.equal(result, SAMPLE_KEY)
    })

    it('handles empty string', () => {
      const payload = encrypt('', PASSWORD)
      const result = decrypt(payload, PASSWORD)
      assert.equal(result, '')
    })

    it('handles long key (256 chars)', () => {
      const longKey = 'x'.repeat(256)
      const payload = encrypt(longKey, PASSWORD)
      const result = decrypt(payload, PASSWORD)
      assert.equal(result, longKey)
    })

    it('handles unicode characters', () => {
      const unicode = '🔑🗝️密码加密测试'
      const payload = encrypt(unicode, PASSWORD)
      const result = decrypt(payload, PASSWORD)
      assert.equal(result, unicode)
    })
  })

  describe('randomness', () => {
    it('different passwords produce different ciphertexts for same input', () => {
      const payload1 = encrypt(SAMPLE_KEY, PASSWORD)
      const payload2 = encrypt(SAMPLE_KEY, 'different-password')
      // Ciphertexts should differ (different keys)
      assert.notDeepEqual(payload1.ciphertext, payload2.ciphertext)
      // Salts will also differ but that's expected
    })

    it('same password + different calls produce different ciphertexts', () => {
      const payload1 = encrypt(SAMPLE_KEY, PASSWORD)
      const payload2 = encrypt(SAMPLE_KEY, PASSWORD)
      // Random salt/IV means ciphertexts must differ
      assert.notDeepEqual(payload1.ciphertext, payload2.ciphertext)
      assert.notDeepEqual(payload1.salt, payload2.salt)
      assert.notDeepEqual(payload1.iv, payload2.iv)
    })

    it('both payloads decrypt to the same value', () => {
      const payload1 = encrypt(SAMPLE_KEY, PASSWORD)
      const payload2 = encrypt(SAMPLE_KEY, PASSWORD)
      assert.equal(decrypt(payload1, PASSWORD), SAMPLE_KEY)
      assert.equal(decrypt(payload2, PASSWORD), SAMPLE_KEY)
    })
  })

  describe('tamper detection', () => {
    it('throws on tampered ciphertext', () => {
      const payload = encrypt(SAMPLE_KEY, PASSWORD)
      // Flip a byte in the ciphertext
      payload.ciphertext[0] ^= 0xff
      assert.throws(() => decrypt(payload, PASSWORD), /authentication tag mismatch/)
    })

    it('throws on tampered auth tag', () => {
      const payload = encrypt(SAMPLE_KEY, PASSWORD)
      payload.authTag[0] ^= 0xff
      assert.throws(() => decrypt(payload, PASSWORD), /authentication tag mismatch/)
    })

    it('throws on tampered IV', () => {
      const payload = encrypt(SAMPLE_KEY, PASSWORD)
      payload.iv[0] ^= 0xff
      assert.throws(() => decrypt(payload, PASSWORD), /authentication tag mismatch/)
    })

    it('throws on truncated ciphertext', () => {
      const payload = encrypt(SAMPLE_KEY, PASSWORD)
      payload.ciphertext = payload.ciphertext.subarray(0, 1)
      assert.throws(() => decrypt(payload, PASSWORD), /authentication tag mismatch/)
    })
  })
})
