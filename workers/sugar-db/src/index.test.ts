import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SugarDB } from './db.ts'

describe('SugarDB', () => {
  let db: SugarDB

  beforeEach(() => {
    db = new SugarDB(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  describe('logEvent', () => {
    it('inserts an event and returns log_id + timestamp', () => {
      const result = db.logEvent({
        event_class: 'test.event',
        source_worker: 'test-worker',
        payload_snapshot: { key: 'value' },
      })

      assert.ok(result.log_id > 0, 'log_id should be positive')
      assert.ok(result.timestamp, 'timestamp should be present')
      assert.match(result.timestamp, /^\d{4}-\d{2}-\d{2}T/, 'timestamp should be ISO8601')
    })

    it('auto-increments log_id', () => {
      const r1 = db.logEvent({ event_class: 'a', source_worker: 'w', payload_snapshot: {} })
      const r2 = db.logEvent({ event_class: 'b', source_worker: 'w', payload_snapshot: {} })

      assert.ok(r2.log_id > r1.log_id, 'second log_id should be greater')
    })

    it('serializes object payload_snapshot as JSON', () => {
      const payload = { nested: { data: [1, 2, 3] } }
      db.logEvent({ event_class: 'test', source_worker: 'w', payload_snapshot: payload })

      const events = db.queryEvents({ event_class: 'test' })
      assert.equal(events.length, 1)
      const parsed = JSON.parse(events[0].payload_snapshot)
      assert.deepEqual(parsed, payload)
    })

    it('accepts string payload_snapshot directly', () => {
      const jsonStr = '{"raw":"string"}'
      db.logEvent({ event_class: 'test', source_worker: 'w', payload_snapshot: jsonStr })

      const events = db.queryEvents({ event_class: 'test' })
      assert.equal(events.length, 1)
      assert.equal(events[0].payload_snapshot, jsonStr)
    })
  })

  describe('queryEvents', () => {
    beforeEach(() => {
      // Seed test data
      db.logEvent({ event_class: 'route.start', source_worker: 'gateway', payload_snapshot: { model: 'gpt-4' } })
      db.logEvent({ event_class: 'route.end', source_worker: 'gateway', payload_snapshot: { success: true } })
      db.logEvent({ event_class: 'vault.check', source_worker: 'vault', payload_snapshot: { provider: 'openai' } })
    })

    it('returns all events when no filters', () => {
      const events = db.queryEvents()
      assert.equal(events.length, 3)
    })

    it('filters by event_class', () => {
      const events = db.queryEvents({ event_class: 'route.start' })
      assert.equal(events.length, 1)
      assert.equal(events[0].event_class, 'route.start')
    })

    it('filters by source_worker', () => {
      const events = db.queryEvents({ source_worker: 'gateway' })
      assert.equal(events.length, 2)
    })

    it('filters by both event_class and source_worker', () => {
      const events = db.queryEvents({ event_class: 'vault.check', source_worker: 'vault' })
      assert.equal(events.length, 1)
    })

    it('respects limit parameter', () => {
      const events = db.queryEvents({ limit: 2 })
      assert.equal(events.length, 2)
    })

    it('returns results ordered by timestamp DESC', () => {
      const events = db.queryEvents()
      // All events may share the same timestamp when inserted rapidly,
      // so we just verify the result is non-empty and sorted
      assert.ok(events.length === 3)
      // Verify timestamps are non-increasing (DESC order)
      for (let i = 1; i < events.length; i++) {
        assert.ok(
          events[i].timestamp <= events[i - 1].timestamp,
          `event[${i}].timestamp should be <= event[${i-1}].timestamp`
        )
      }
    })

    it('returns empty array for non-matching filter', () => {
      const events = db.queryEvents({ event_class: 'nonexistent' })
      assert.equal(events.length, 0)
    })
  })

  describe('status', () => {
    it('returns zero count for empty database', () => {
      const status = db.status()
      assert.equal(status.row_count, 0)
      assert.equal(status.last_event_timestamp, null)
    })

    it('returns correct count and last timestamp', () => {
      db.logEvent({ event_class: 'a', source_worker: 'w', payload_snapshot: {} })
      db.logEvent({ event_class: 'b', source_worker: 'w', payload_snapshot: {} })

      const status = db.status()
      assert.equal(status.row_count, 2)
      assert.ok(status.last_event_timestamp, 'should have last_event_timestamp')
    })

    it('updates count after new events', () => {
      const s1 = db.status()
      assert.equal(s1.row_count, 0)

      db.logEvent({ event_class: 'x', source_worker: 'w', payload_snapshot: {} })

      const s2 = db.status()
      assert.equal(s2.row_count, 1)
    })
  })
})
