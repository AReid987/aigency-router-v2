/**
 * test-heal-flow — Integration test for end-to-end heal round-trip.
 *
 * Exercises the full heal flow with all deps injected (no real HTTP calls):
 *   1. routeLlm is called with a provider that returns empty content
 *   2. FailoverEngine detects malformed (empty) response and calls tryHeal
 *   3. tryHeal calls callEngramHeal → iii.trigger('engram::heal_json')
 *   4. engram::heal_json returns { success: true, data: {...} }
 *   5. callEngramHeal transforms to { repaired: '{"fixed":true}' }
 *   6. healMalformedJson parses it and returns the repaired object
 *   7. FailoverEngine returns the healed ProviderResponse
 *
 * All providers are injected via RouteLlmDeps.getProviderConfig so
 * no module-level mocking is needed.
 *
 * Run: npx tsx tests/integration/test-heal-flow.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeLlm, type RouteLlmDeps } from '../../workers/gateway/src/index.ts'
import { callEngramHeal, HEAL_TIMEOUT_MS } from '../../workers/gateway/src/heal-integration.ts'
import type { ISdk, StreamChannelRef, ChannelReader } from 'iii-sdk'

// ── Test fixtures ─────────────────────────────────────────────────────

const TEST_PROVIDER_CONFIG = { baseUrl: 'https://test.example.com/v1/chat/completions', envKey: 'TEST_API_KEY' }

type TestProviderResponse = {
  id: string
  content: string
  finishReason: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

function makeMockGetProviderConfig(extra?: Record<string, { baseUrl: string; envKey: string }>) {
  const extraMap = extra ?? {}
  return (providerId: string) => {
    if (providerId === 'test-provider' || providerId === 'second-provider') {
      return TEST_PROVIDER_CONFIG
    }
    return extraMap[providerId]
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Heal Flow Integration', () => {
  it('routeLlm returns the healed response when provider returns empty content', async () => {
    const triggerCalls: Array<{ function_id: string; payload: unknown }> = []

    // Provider returns empty content → triggers heal path
    const mockCallProvider = async (): Promise<TestProviderResponse> => ({
      id: 'chatcmpl-empty',
      content: '',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
    })

    // sdk trigger: engram::heal_json returns the healed data
    const mockTrigger = async (opts: { function_id: string; payload: unknown }) => {
      triggerCalls.push(opts as { function_id: string; payload: unknown })
      if ((opts as { function_id: string }).function_id === 'engram::heal_json') {
        return { success: true, data: { fixed: true, message: 'healed!' }, attempts: 1 }
      }
      return null
    }

    const deps: RouteLlmDeps = {
      resolveModel: async (model) => ({
        model,
        providers: ['test-provider/test-model'],
        resolved: true,
      }),
      getKey: async () => 'test-api-key',
      callProvider: mockCallProvider as RouteLlmDeps['callProvider'],
      getProviderConfig: makeMockGetProviderConfig(),
      iii: { trigger: mockTrigger } as unknown as ISdk,
      callEngramHeal,
    }

    const result = await routeLlm(
      { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: false },
      deps,
    )

    // Assertions
    assert.equal(result.success, true, `routeLlm should succeed, got: ${JSON.stringify(result)}`)
    const rt = result as { success: true; provider: string; response: { content: string } }

    // Content should be the healed JSON (serialized data from engram::heal_json)
    const content: string = rt.response?.content ?? ''
    assert.ok(
      content.includes('"fixed"') || content.includes('healed'),
      `Expected healed content, got: ${content}`,
    )

    // engram::heal_json was called exactly once
    const healCalls = triggerCalls.filter((c) => c.function_id === 'engram::heal_json')
    assert.equal(healCalls.length, 1, `Expected exactly 1 engram::heal_json call, got ${healCalls.length}`)
  })

  it('routeLlm returns the provider response directly when content is non-empty', async () => {
    const triggerCalls: Array<{ function_id: string; payload: unknown }> = []

    const mockCallProvider = async (): Promise<TestProviderResponse> => ({
      id: 'chatcmpl-good',
      content: 'normal response',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })

    const mockTrigger = async (opts: { function_id: string; payload: unknown }) => {
      triggerCalls.push(opts as { function_id: string; payload: unknown })
      if ((opts as { function_id: string }).function_id === 'engram::heal_json') {
        return { success: true, data: { unexpected: true }, attempts: 1 }
      }
      return null
    }

    const deps: RouteLlmDeps = {
      resolveModel: async (model) => ({ model, providers: ['test-provider/test-model'], resolved: true }),
      getKey: async () => 'test-api-key',
      callProvider: mockCallProvider as RouteLlmDeps['callProvider'],
      getProviderConfig: makeMockGetProviderConfig(),
      iii: { trigger: mockTrigger } as unknown as ISdk,
      callEngramHeal,
    }

    const result = await routeLlm(
      { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: false },
      deps,
    )

    assert.equal(result.success, true)
    const rt = result as { success: true; response: { content: string } }
    assert.equal(rt.response?.content, 'normal response', 'Non-empty response should be returned directly')

    // engram::heal_json should NOT be called for non-empty responses
    const healCalls = triggerCalls.filter((c) => c.function_id === 'engram::heal_json')
    assert.equal(healCalls.length, 0, 'engram::heal_json should not be called for non-empty responses')
  })

  it('routeLlm returns the original (empty) response when heal returns null', async () => {
    const triggerCalls: Array<{ function_id: string; payload: unknown }> = []

    // First call returns empty content, second call returns valid response
    let providerCallCount = 0
    const mockCallProvider = async (): Promise<TestProviderResponse> => {
      providerCallCount++
      if (providerCallCount === 1) {
        return { id: 'chatcmpl-empty', content: '', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } }
      }
      return { id: 'chatcmpl-second', content: 'second provider response', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
    }

    const mockTrigger = async (opts: { function_id: string; payload: unknown }) => {
      triggerCalls.push(opts as { function_id: string; payload: unknown })
      if ((opts as { function_id: string }).function_id === 'engram::heal_json') {
        // Heal fails
        return { success: false, error: 'parse_failed', attempts: 0 }
      }
      return null
    }

    const deps: RouteLlmDeps = {
      resolveModel: async (model) => ({
        model,
        providers: ['test-provider/test-model', 'second-provider/test-model'],
        resolved: true,
      }),
      getKey: async () => 'test-api-key',
      callProvider: mockCallProvider as RouteLlmDeps['callProvider'],
      getProviderConfig: makeMockGetProviderConfig(),
      iii: { trigger: mockTrigger } as unknown as ISdk,
      callEngramHeal,
    }

    const result = await routeLlm(
      { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: false },
      deps,
    )

    // When heal returns null, FailoverEngine returns the ORIGINAL (empty) response,
    // not a fallback to the next provider. The heal is an enrichment, not a retry.
    assert.equal(result.success, true)
    const rt = result as { success: true; provider: string; response: { content: string } }
    assert.equal(rt.provider, 'test-provider', 'Should return first provider response even when heal fails')
    assert.equal(rt.response?.content, '', 'Original empty response should be returned when heal returns null')
  })

  it('routeLlm returns empty content when no heal is wired and provider returns empty', async () => {
    const mockCallProvider = async (): Promise<TestProviderResponse> => ({
      id: 'chatcmpl-empty',
      content: '',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
    })

    const deps: RouteLlmDeps = {
      resolveModel: async (model) => ({ model, providers: ['test-provider/test-model'], resolved: true }),
      getKey: async () => 'test-api-key',
      callProvider: mockCallProvider as RouteLlmDeps['callProvider'],
      getProviderConfig: makeMockGetProviderConfig(),
      // No iii or callEngramHeal — heal is disabled
    }

    const result = await routeLlm(
      { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: false },
      deps,
    )

    assert.equal(result.success, true)
    const rt = result as { success: true; response: { content: string } }
    assert.equal(rt.response?.content, '', 'Empty content should be returned when heal is not wired')
  })
})
