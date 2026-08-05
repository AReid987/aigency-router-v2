/**
 * size-limit.test.ts — Unit tests for createSizeLimitMiddleware and
 * getActiveSizeLimitMiddleware.
 *
 * Run: cd workers/gateway && tsx --test src/size-limit.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createSizeLimitMiddleware,
  getActiveSizeLimitMiddleware,
  attachStreamingSizeGuard,
} from './middleware.ts'

// ── Helpers ────────────────────────────────────────────────────────────

function mockRequest(overrides: Record<string, any> = {}) {
  return {
    url: '/v1/chat/completions',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {},
    body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }
}

function telemetrySpy() {
  const events: Array<{ class: string; data: any }> = []
  return {
    emit: (eventClass: string, data: any) => {
      events.push({ class: eventClass, data })
    },
    events,
  }
}

class FakeRequest extends EventEmitter {
  headers: Record<string, any>
  url: string
  method: string
  constructor(headers: Record<string, any> = {}, url = '/v1/chat/completions', method = 'POST') {
    super()
    this.headers = headers
    this.url = url
    this.method = method
  }
}

class FakeSocket extends EventEmitter {
  destroyed = false
  destroy() {
    this.destroyed = true
  }
}

// ── Tests: createSizeLimitMiddleware ─────────────────────────────────

describe('createSizeLimitMiddleware', () => {
  // ── 1. Content-Length within limit → pass ────────────────────────
  it('(1) Content-Length within limit passes through', () => {
    const m = createSizeLimitMiddleware({ maxBytes: 1024 })
    const req = mockRequest({ headers: { 'content-length': '500' } })
    const result = m(req)
    assert.equal(result.rejected, false)
  })

  // ── 2. Content-Length over limit → 413 ──────────────────────────
  it('(2) Content-Length over limit rejects with 413 and JSON body', () => {
    const tel = telemetrySpy()
    const m = createSizeLimitMiddleware({ maxBytes: 1024, telemetry: tel })
    const req = mockRequest({
      url: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-length': '2048' },
    })
    const result = m(req)
    assert.equal(result.rejected, true)
    assert.equal(result.status, 413)
    assert.match(result.body!, /"error":"request_too_large"/)
    assert.match(result.body!, /"maxBytes":1024/)
    assert.equal(tel.events.length, 1)
    assert.equal(tel.events[0].class, 'REQUEST_TOO_LARGE')
    assert.equal(tel.events[0].data.source, 'content_length')
  })

  // ── 3. Content-Length equal to limit → pass ─────────────────────
  it('(3) Content-Length exactly at limit passes through', () => {
    const m = createSizeLimitMiddleware({ maxBytes: 1024 })
    const req = mockRequest({ headers: { 'content-length': '1024' } })
    const result = m(req)
    assert.equal(result.rejected, false)
  })

  // ── 4. Missing Content-Length → pass (caller must attach streaming guard) ─
  it('(4) missing Content-Length returns pass-through; streaming guard is caller responsibility', () => {
    const m = createSizeLimitMiddleware({ maxBytes: 1024 })
    const req = mockRequest({ headers: {} })
    const result = m(req)
    assert.equal(result.rejected, false)
  })

  // ── 5. Malformed Content-Length → pass (treat as unknown) ───────
  it('(5) malformed Content-Length returns pass-through', () => {
    const m = createSizeLimitMiddleware({ maxBytes: 1024 })
    const req = mockRequest({ headers: { 'content-length': 'not-a-number' } })
    const result = m(req)
    assert.equal(result.rejected, false)
  })
})

// ── Tests: attachStreamingSizeGuard ──────────────────────────────────

describe('attachStreamingSizeGuard', () => {
  // ── 6. Streaming body within limit → no destroy ─────────────────
  it('(6) streaming body within limit does not destroy socket', () => {
    const req = new FakeRequest()
    const socket = new FakeSocket()
    const teardown = attachStreamingSizeGuard(req, socket, 1024, undefined, {
      path: '/v1/chat/completions',
      method: 'POST',
    })
    req.emit('data', Buffer.from('hello'))
    req.emit('data', Buffer.from(' world'))
    assert.equal(socket.destroyed, false)
    teardown()
  })

  // ── 7. Streaming body over limit → destroy + telemetry ─────────
  it('(7) streaming body over limit destroys socket and emits telemetry', () => {
    const req = new FakeRequest()
    const socket = new FakeSocket()
    const tel = telemetrySpy()
    const teardown = attachStreamingSizeGuard(req, socket, 16, tel, {
      path: '/v1/chat/completions',
      method: 'POST',
    })
    req.emit('data', Buffer.alloc(8, 'a'))
    assert.equal(socket.destroyed, false)
    req.emit('data', Buffer.alloc(8, 'b'))
    // cumulative 16 bytes — at limit, not yet over
    assert.equal(socket.destroyed, false)
    req.emit('data', Buffer.alloc(8, 'c'))
    // cumulative 24 bytes — over limit
    assert.equal(socket.destroyed, true)
    assert.equal(tel.events.length, 1)
    assert.equal(tel.events[0].class, 'REQUEST_TOO_LARGE')
    assert.equal(tel.events[0].data.source, 'streaming')
    assert.equal(tel.events[0].data.bytesReceived, 24)
    assert.equal(tel.events[0].data.maxBytes, 16)
    teardown()
  })

  // ── 8. Teardown removes listener ──────────────────────────────
  it('(8) teardown removes the data listener so subsequent emits are no-ops', () => {
    const req = new FakeRequest()
    const socket = new FakeSocket()
    const teardown = attachStreamingSizeGuard(req, socket, 16, undefined, {
      path: '/v1/chat/completions',
      method: 'POST',
    })
    teardown()
    req.emit('data', Buffer.alloc(100, 'x'))
    assert.equal(socket.destroyed, false)
  })

  // ── 9. String chunks counted by byte length ─────────────────────
  it('(9) string chunks are counted by byte length, not char count', () => {
    const req = new FakeRequest()
    const socket = new FakeSocket()
    const teardown = attachStreamingSizeGuard(req, socket, 8, undefined, {
      path: '/v1/chat/completions',
      method: 'POST',
    })
    // 8-char string is 8 bytes in UTF-8
    req.emit('data', '12345678')
    assert.equal(socket.destroyed, false)
    // 1 more byte puts us over
    req.emit('data', '9')
    assert.equal(socket.destroyed, true)
    teardown()
  })
})

// ── Tests: getActiveSizeLimitMiddleware (env-gated) ────────────────

describe('getActiveSizeLimitMiddleware (env-gated)', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    delete process.env.GATEWAY_MAX_REQUEST_BYTES
  })
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  // ── 10. Default-off: no rejection ──────────────────────────────
  it('(10) GATEWAY_MAX_REQUEST_BYTES unset returns a no-op middleware', () => {
    const m = getActiveSizeLimitMiddleware()
    const result = m(mockRequest({ headers: { 'content-length': '99999999' } }))
    assert.equal(result.rejected, false)
  })

  // ── 11. Gate on → 413 on oversized body ─────────────────────────
  it('(11) GATEWAY_MAX_REQUEST_BYTES=1024 rejects oversized body', () => {
    process.env.GATEWAY_MAX_REQUEST_BYTES = '1024'
    const m = getActiveSizeLimitMiddleware()
    const result = m(mockRequest({ headers: { 'content-length': '2048' } }))
    assert.equal(result.rejected, true)
    assert.equal(result.status, 413)
  })

  // ── 12. Malformed env value → noop ────────────────────────────
  it('(12) malformed GATEWAY_MAX_REQUEST_BYTES returns no-op', () => {
    process.env.GATEWAY_MAX_REQUEST_BYTES = 'not-a-number'
    const m = getActiveSizeLimitMiddleware()
    const result = m(mockRequest({ headers: { 'content-length': '99999999' } }))
    assert.equal(result.rejected, false)
  })

  // ── 13. Empty env value → noop ─────────────────────────────────
  it('(13) empty GATEWAY_MAX_REQUEST_BYTES returns no-op', () => {
    process.env.GATEWAY_MAX_REQUEST_BYTES = ''
    const m = getActiveSizeLimitMiddleware()
    const result = m(mockRequest({ headers: { 'content-length': '99999999' } }))
    assert.equal(result.rejected, false)
  })

  // ── 14. Negative env value → noop ─────────────────────────────
  it('(14) negative GATEWAY_MAX_REQUEST_BYTES returns no-op', () => {
    process.env.GATEWAY_MAX_REQUEST_BYTES = '-1'
    const m = getActiveSizeLimitMiddleware()
    const result = m(mockRequest({ headers: { 'content-length': '99999999' } }))
    assert.equal(result.rejected, false)
  })
})
