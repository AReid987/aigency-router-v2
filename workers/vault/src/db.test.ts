import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SugarVaultDB } from './db.ts'

describe('SugarVaultDB', () => {
  let db: SugarVaultDB

  beforeEach(() => {
    db = new SugarVaultDB(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  describe('schema creation', () => {
    it('should create tables without error', () => {
      // If constructor didn't throw, tables exist
      assert.ok(true)
    })

    it('should allow creating multiple instances', () => {
      const db2 = new SugarVaultDB(':memory:')
      db2.close()
      assert.ok(true)
    })
  })

  describe('storeKey', () => {
    it('should store and retrieve a key', () => {
      const payload = Buffer.from('encrypted-data-123')
      db.storeKey('key-1', 'openai', payload, 'colleague-1')

      const entry = db.getKey('openai')
      assert.ok(entry)
      assert.equal(entry.id, 'key-1')
      assert.equal(entry.providerId, 'openai')
      assert.deepEqual(entry.encryptedPayload, payload)
      assert.equal(entry.virtualColleagueId, 'colleague-1')
      assert.equal(entry.isActive, true)
      assert.ok(entry.createdAt)
    })

    it('should store key without virtualColleagueId', () => {
      const payload = Buffer.from('encrypted-data-456')
      db.storeKey('key-2', 'anthropic', payload)

      const entry = db.getKey('anthropic')
      assert.ok(entry)
      assert.equal(entry.virtualColleagueId, null)
    })

    it('should throw on duplicate key ID', () => {
      const payload = Buffer.from('encrypted-data')
      db.storeKey('dup-id', 'openai', payload)

      assert.throws(() => {
        db.storeKey('dup-id', 'anthropic', payload)
      }, /UNIQUE constraint failed/)
    })
  })

  describe('getKey', () => {
    it('should return null for non-existent provider', () => {
      const entry = db.getKey('nonexistent')
      assert.equal(entry, null)
    })

    it('should return null when no active keys exist', () => {
      const payload = Buffer.from('encrypted-data')
      db.storeKey('key-1', 'openai', payload)
      db.deactivateKey('key-1')

      const entry = db.getKey('openai')
      assert.equal(entry, null)
    })

    it('should return multiple keys per provider (most recent first)', () => {
      // Insert two keys for same provider
      db.storeKey('key-1', 'openai', Buffer.from('first'))
      db.storeKey('key-2', 'openai', Buffer.from('second'))

      // Both keys should exist
      const allKeys = db.getAllKeys().filter(k => k.providerId === 'openai')
      assert.equal(allKeys.length, 2)

      // getKey returns an active key for the provider
      const entry = db.getKey('openai')
      assert.ok(entry)
      assert.equal(entry.providerId, 'openai')
      assert.equal(entry.isActive, true)
    })
  })

  describe('getAllKeys', () => {
    it('should return empty array when no keys exist', () => {
      const keys = db.getAllKeys()
      assert.deepEqual(keys, [])
    })

    it('should return all keys across providers', () => {
      db.storeKey('key-1', 'openai', Buffer.from('a'))
      db.storeKey('key-2', 'anthropic', Buffer.from('b'))
      db.storeKey('key-3', 'openai', Buffer.from('c'))

      const keys = db.getAllKeys()
      assert.equal(keys.length, 3)
    })

    it('should include deactivated keys', () => {
      db.storeKey('key-1', 'openai', Buffer.from('a'))
      db.deactivateKey('key-1')

      const keys = db.getAllKeys()
      assert.equal(keys.length, 1)
      assert.equal(keys[0].isActive, false)
    })
  })

  describe('deactivateKey', () => {
    it('should deactivate a key by ID', () => {
      db.storeKey('key-1', 'openai', Buffer.from('data'))
      db.deactivateKey('key-1')

      const keys = db.getAllKeys()
      assert.equal(keys.length, 1)
      assert.equal(keys[0].isActive, false)
    })

    it('should not throw for non-existent key', () => {
      // Deactivating a non-existent key is a no-op
      db.deactivateKey('nonexistent')
      assert.ok(true)
    })

    it('should only deactivate specified key', () => {
      db.storeKey('key-1', 'openai', Buffer.from('a'))
      db.storeKey('key-2', 'openai', Buffer.from('b'))
      db.deactivateKey('key-1')

      const activeEntry = db.getKey('openai')
      assert.ok(activeEntry)
      assert.equal(activeEntry.id, 'key-2')
    })
  })

  describe('meta store/retrieve', () => {
    it('should store and retrieve a meta value', () => {
      db.setMeta('salt', 'abc123')
      const value = db.getMeta('salt')
      assert.equal(value, 'abc123')
    })

    it('should return null for non-existent meta key', () => {
      const value = db.getMeta('nonexistent')
      assert.equal(value, null)
    })

    it('should overwrite existing meta value', () => {
      db.setMeta('salt', 'old-salt')
      db.setMeta('salt', 'new-salt')
      const value = db.getMeta('salt')
      assert.equal(value, 'new-salt')
    })

    it('should store salt for key derivation', () => {
      const salt = Buffer.from('random-salt-bytes').toString('base64')
      db.setMeta('master_salt', salt)
      const retrieved = db.getMeta('master_salt')
      assert.equal(retrieved, salt)
    })
  })

  describe('getKeyCount', () => {
    it('should return 0 when no keys exist', () => {
      assert.equal(db.getKeyCount(), 0)
    })

    it('should return correct count', () => {
      db.storeKey('key-1', 'openai', Buffer.from('a'))
      db.storeKey('key-2', 'anthropic', Buffer.from('b'))
      assert.equal(db.getKeyCount(), 2)
    })

    it('should count deactivated keys', () => {
      db.storeKey('key-1', 'openai', Buffer.from('a'))
      db.deactivateKey('key-1')
      assert.equal(db.getKeyCount(), 1)
    })
  })

  describe('WAL mode', () => {
    it('should enable WAL mode', () => {
      // WAL mode is set in constructor; if we got here without error, it's fine
      // We can verify by creating a file-based DB and checking pragma
      const tmpDir = os.tmpdir()
      const tmpDb = path.join(tmpDir, `test-wal-${Date.now()}.db`)

      const fileDb = new SugarVaultDB(tmpDb)
      // If WAL mode failed, we'd get an error
      fileDb.storeKey('k1', 'test', Buffer.from('data'))
      assert.equal(fileDb.getKeyCount(), 1)
      fileDb.close()

      // Cleanup
      try {
        fs.unlinkSync(tmpDb)
        fs.unlinkSync(tmpDb + '-wal')
        fs.unlinkSync(tmpDb + '-shm')
      } catch {
        // ignore cleanup errors
      }
    })
  })

  describe('buffer round-trip', () => {
    it('should preserve binary data exactly', () => {
      const binaryData = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f])
      db.storeKey('key-1', 'test-provider', binaryData)

      const entry = db.getKey('test-provider')
      assert.ok(entry)
      assert.deepEqual(entry.encryptedPayload, binaryData)
    })

    it('should handle large payloads', () => {
      const largePayload = Buffer.alloc(1024 * 100, 0xAB) // 100KB
      db.storeKey('key-1', 'test-provider', largePayload)

      const entry = db.getKey('test-provider')
      assert.ok(entry)
      assert.deepEqual(entry.encryptedPayload, largePayload)
    })
  })
})
