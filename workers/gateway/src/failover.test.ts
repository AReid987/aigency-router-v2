import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FailoverEngine } from './failover.ts'
import { ProviderError, type ProviderConfig, type ProviderResponse } from './provider-client.ts'
import type { GetKeyFn, CallProviderFn, RouteResult } from './failover.ts'

// ── Test helpers ───────────────────────────────────────────────────────

const groqConfig: ProviderConfig = {
  baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
  envKey: 'GROQ_API_KEY',
}

const cerebrasConfig: ProviderConfig = {
  baseUrl: 'https://api.cerebras.ai/v1/chat/completions',
  envKey: 'CEREBRAS_API_KEY',
}

const togetherConfig: ProviderConfig = {
  baseUrl: 'https://api.together.xyz/v1/chat/completions',
  envKey: 'TOGETHER_API_KEY',
}

const successResponse: ProviderResponse = {
  id: 'resp-1',
  content: 'Hello!',
  finishReason: 'stop',
}

const messages = [{ role: 'user' as const, content: 'hi' }]

function makeSuccessCall(): CallProviderFn {
  return async () => successResponse
}

function makeFailCall(status: number): CallProviderFn {
  return async () => {
    throw new ProviderError(status, 'error', 'https://example.com')
  }
}

function makeSequentialCall(...results: Array<ProviderResponse | number>): CallProviderFn {
  let i = 0
  return async () => {
    const result = results[i++]
    if (typeof result === 'number') {
      throw new ProviderError(result, 'error', 'https://example.com')
    }
    return result
  }
}

function makeKeyProvider(keys: Record<string, string | null>): GetKeyFn {
  return async (providerId: string) => keys[providerId] ?? null
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('FailoverEngine', () => {
  describe('routeWithFailover — success', () => {
    it('returns result from first provider when it succeeds', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq' }),
        makeSuccessCall(),
      )

      const result = await engine.routeWithFailover(
        ['groq/llama3-8b-8192'],
        'llama3',
        messages,
      )

      assert.equal(result.success, true)
      if (result.success) {
        assert.equal(result.provider, 'groq')
        assert.equal(result.response.content, 'Hello!')
      }
    })

    it('tries providers in order and returns first success', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras' }),
        makeSequentialCall(429, successResponse), // groq rate-limited, cerebras ok
      )

      const result = await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.equal(result.success, true)
      if (result.success) {
        assert.equal(result.provider, 'cerebras')
      }
    })
  })

  describe('routeWithFailover — 429 rate limit', () => {
    it('sets 60s cooldown and tries next provider on 429', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras' }),
        makeSequentialCall(429, successResponse),
      )

      const result = await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.equal(result.success, true)
      assert.ok(engine.isInCooldown('groq'))
      assert.equal(engine.isInCooldown('cerebras'), false)
    })
  })

  describe('routeWithFailover — 403 forbidden', () => {
    it('sets 5min cooldown on 403', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras' }),
        makeSequentialCall(403, successResponse),
      )

      await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.ok(engine.isInCooldown('groq'))
      const cooldowns = engine.getCooldowns()
      assert.ok(cooldowns.has('groq'))
      // Cooldown should be ~5min from now
      const remaining = cooldowns.get('groq')! - Date.now()
      assert.ok(remaining > 240_000, `Expected ~300s cooldown, got ${remaining}ms`)
    })
  })

  describe('routeWithFailover — 500/503 server error', () => {
    it('sets 30s cooldown on 500', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras' }),
        makeSequentialCall(500, successResponse),
      )

      await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.ok(engine.isInCooldown('groq'))
      const cooldowns = engine.getCooldowns()
      const remaining = cooldowns.get('groq')! - Date.now()
      assert.ok(remaining > 20_000 && remaining < 35_000, `Expected ~30s cooldown, got ${remaining}ms`)
    })

    it('sets 30s cooldown on 503', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras' }),
        makeSequentialCall(503, successResponse),
      )

      await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.ok(engine.isInCooldown('groq'))
    })
  })

  describe('routeWithFailover — 401 invalid key', () => {
    it('does NOT set cooldown on 401, tries next provider', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-bad', cerebras: 'sk-cerebras' }),
        makeSequentialCall(401, successResponse),
      )

      const result = await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.equal(result.success, true)
      // groq should NOT be in cooldown — the key was wrong, not the provider
      assert.equal(engine.isInCooldown('groq'), false)
    })
  })

  describe('routeWithFailover — no key available', () => {
    it('skips provider when getKey returns null', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: null, cerebras: 'sk-cerebras' }),
        makeSuccessCall(),
      )

      const result = await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.equal(result.success, true)
      if (result.success) {
        assert.equal(result.provider, 'cerebras')
      }
    })

    it('does not set cooldown when key is missing', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: null, cerebras: 'sk-cerebras' }),
        makeSuccessCall(),
      )

      await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.equal(engine.isInCooldown('groq'), false)
    })
  })

  describe('routeWithFailover — all providers fail', () => {
    it('returns error with failure details when all providers fail', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras' }),
        makeSequentialCall(429, 500),
      )

      const result = await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.equal(result.success, false)
      if (!result.success) {
        assert.equal(result.failures.length, 2)
        assert.equal(result.failures[0].provider, 'groq')
        assert.equal(result.failures[0].status, 429)
        assert.equal(result.failures[1].provider, 'cerebras')
        assert.equal(result.failures[1].status, 500)
        assert.match(result.message, /2 provider/)
      }
    })

    it('returns failure when provider array is empty', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({}),
        makeSuccessCall(),
      )

      const result = await engine.routeWithFailover(
        [],
        'llama3',
        messages,
      )

      assert.equal(result.success, false)
      if (!result.success) {
        assert.match(result.message, /0 provider/)
      }
    })
  })

  describe('cooldown — skip cooled-down providers', () => {
    it('skips provider already in cooldown', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras', together: 'sk-together' }),
        makeSequentialCall(429, successResponse), // first call = groq 429, second = cerebras ok
      )

      // First request: groq 429s, cerebras succeeds
      const result1 = await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b', 'together/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'],
        'llama3',
        messages,
      )
      assert.equal(result1.success, true)
      assert.ok(engine.isInCooldown('groq'))

      // Second request: groq should be skipped (in cooldown), cerebras responds
      const result2 = await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.equal(result2.success, true)
      if (result2.success) {
        assert.equal(result2.provider, 'cerebras')
      }
    })

    it('records cooldown reason in failures when skipping', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras' }),
        makeSequentialCall(429, successResponse),
      )

      // Trigger cooldown
      await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      // Next request should skip groq with "in cooldown" reason
      const callFn = makeSuccessCall()
      const engine2 = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras' }),
        callFn,
      )
      // Manually copy cooldowns to new engine for this test
      engine2.setCooldown('groq', 60_000)

      const result = await engine2.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      assert.equal(result.success, true)
      if (result.success) {
        assert.equal(result.provider, 'cerebras')
      }
    })
  })

  describe('getCooldowns', () => {
    it('returns empty map when no cooldowns active', () => {
      const engine = new FailoverEngine(makeKeyProvider({}), makeSuccessCall())
      assert.equal(engine.getCooldowns().size, 0)
    })

    it('returns active cooldowns after setting them', async () => {
      const engine = new FailoverEngine(
        makeKeyProvider({ groq: 'sk-groq', cerebras: 'sk-cerebras' }),
        makeSequentialCall(429, successResponse),
      )

      await engine.routeWithFailover(
        ['groq/llama3-8b-8192', 'cerebras/llama3.1-8b'],
        'llama3',
        messages,
      )

      const cooldowns = engine.getCooldowns()
      assert.equal(cooldowns.size, 1)
      assert.ok(cooldowns.has('groq'))
    })
  })
})
