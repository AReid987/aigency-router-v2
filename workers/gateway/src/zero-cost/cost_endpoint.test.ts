/**
 * Cost endpoint unit tests.
 *
 * Tests the GET /v1/admin/cost handler with mocked CostReporter.
 * Uses node:test and node:assert/strict.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createCostEndpointHandler } from './cost_endpoint.ts'
import type { CostReport, CostReporter } from './cost_endpoint.ts'

// ── Test helpers ───────────────────────────────────────────────────────

interface MockExchange {
  req: Partial<IncomingMessage>
  res: Partial<ServerResponse>
  statusCode: number
  headers: Record<string, string>
  body: string
}

/**
 * Create mock req/res objects and record what the handler writes.
 * Returns a mutable exchange object updated by the handler.
 */
function createMockExchange(url?: string, method?: string): MockExchange {
  const exchange: MockExchange = {
    req: { url, method: method ?? 'GET' },
    res: {},
    statusCode: 200,
    headers: {},
    body: '',
  }

  // Use a getter/setter so that res.statusCode = N updates exchange.statusCode
  Object.defineProperty(exchange.res, 'statusCode', {
    get: () => exchange.statusCode,
    set: (v: number) => { exchange.statusCode = v },
    configurable: true,
    enumerable: true,
  })

  exchange.res.setHeader = (key: string, value: string | number) => {
    exchange.headers[key] = String(value)
  }
  exchange.res.end = (data?: unknown) => {
    if (typeof data === 'string') {
      exchange.body = data
    }
  }

  return exchange
}

/**
 * Create a mock CostReporter with a controllable response.
 * Tracks getCostReport arguments for assertion.
 */
interface MockCostReporter extends CostReporter {
  getCostReportCalls: Array<{ sinceMs?: number }>
}

function createMockReporter(
  report: Partial<CostReport> = {},
): MockCostReporter {
  const calls: Array<Record<string, unknown>> = []

  const defaultReport: CostReport = {
    total_requests: 1000,
    free_tier_requests: 900,
    paid_tier_requests: 100,
    paid_tier_refused: 5,
    estimated_savings_usd: 12.5,
    per_provider: [
      {
        name: 'groq',
        requests: 500,
        free_tier_requests: 450,
        paid_tier_refused: 2,
        estimated_savings_usd: 5.0,
      },
      {
        name: 'cerebras',
        requests: 500,
        free_tier_requests: 450,
        paid_tier_refused: 3,
        estimated_savings_usd: 2.5,
      },
    ],
    daily: [
      { date: '2026-06-19', total_requests: 200, savings_usd: 2.5 },
      { date: '2026-06-20', total_requests: 300, savings_usd: 3.75 },
    ],
    generated_at: Date.now(),
  }

  const mock: MockCostReporter = {
    getCostReport: async (opts?: { sinceMs?: number }) => {
      calls.push({ sinceMs: opts?.sinceMs })
      return { ...defaultReport, ...report }
    },
    getCostReportCalls: calls,
  }
  return mock
}

// ── Environment helper ─────────────────────────────────────────────────

const ENV_BACKUPS = new Map<string, string | undefined>()

function saveEnv(keys: string[]): void {
  for (const key of keys) {
    ENV_BACKUPS.set(key, process.env[key])
  }
}

function restoreEnv(keys: string[]): void {
  for (const key of keys) {
    const saved = ENV_BACKUPS.get(key)
    if (saved === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved
    }
  }
  ENV_BACKUPS.clear()
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Cost endpoint', () => {
  const AFFECTED_ENV = [
    'GATEWAY_COST_REPORTING',
    'COST_RATE_GROQ_USD',
    'COST_RATE_CEREBRAS_USD',
    'COST_RATE_TOGETHER_USD',
    'COST_RATE_OPENAI_USD',
    'COST_RATE_ANTHROPIC_USD',
  ]

  before(() => {
    saveEnv(AFFECTED_ENV)
  })

  after(() => {
    restoreEnv(AFFECTED_ENV)
  })

  // ── 1. 404 when GATEWAY_COST_REPORTING not set ─────────────────────

  it('returns 404 when GATEWAY_COST_REPORTING is not set', async () => {
    delete process.env.GATEWAY_COST_REPORTING

    const reporter = createMockReporter()
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    assert.equal(exchange.statusCode, 404)
    assert.equal(exchange.headers['content-type'], 'application/json')
    const parsed = JSON.parse(exchange.body)
    assert.equal(parsed.error, 'Not found')
  })

  // ── 2. 200 + JSON when GATEWAY_COST_REPORTING=true ─────────────────

  it('returns 200 with JSON body when GATEWAY_COST_REPORTING=true', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'

    const reporter = createMockReporter()
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    assert.equal(exchange.statusCode, 200)
    assert.equal(exchange.headers['content-type'], 'application/json')
    const parsed = JSON.parse(exchange.body)
    assert.equal(parsed.total_requests, 1000)
    assert.equal(parsed.estimated_savings_usd, 12.5)
  })

  // ── 3. Default days = 7 when query param absent ────────────────────

  it('defaults to 7 days when query param is absent', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'

    const reporter = createMockReporter()
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    const parsed = JSON.parse(exchange.body)
    assert.equal(parsed.query_days, 7)

    // Verify the reporter received sinceMs ~7 days ago
    assert.equal(reporter.getCostReportCalls.length, 1)
    const expectedSince = Date.now() - 7 * 86_400_000
    const actualSince = reporter.getCostReportCalls[0].sinceMs!
    // Allow 5s tolerance for test execution
    const toleranceMs = 5000
    assert.ok(
      Math.abs(actualSince - expectedSince) <= toleranceMs,
      `sinceMs should be ~7 days ago, got diff ${actualSince - expectedSince}ms`,
    )
  })

  // ── 4. ?days=30 query param parsed correctly ───────────────────────

  it('parses ?days=30 query param correctly', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'

    const reporter = createMockReporter()
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost?days=30')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    const parsed = JSON.parse(exchange.body)
    assert.equal(parsed.query_days, 30)
  })

  // ── 5. ?days=invalid (non-numeric) defaults to 7 ───────────────────

  it('defaults to 7 when days param is non-numeric', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'

    const reporter = createMockReporter()
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost?days=abc')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    const parsed = JSON.parse(exchange.body)
    assert.equal(parsed.query_days, 7)
  })

  // ── 6. ?days=-1 (negative) defaults to 7 ───────────────────────────

  it('defaults to 7 when days param is negative', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'

    const reporter = createMockReporter()
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost?days=-1')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    const parsed = JSON.parse(exchange.body)
    assert.equal(parsed.query_days, 7)
  })

  // ── 7. Env rate loading: COST_RATE_GROQ_USD overrides default ─────

  it('loads cost rates from env and includes them in response', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'
    process.env.COST_RATE_GROQ_USD = '0.025'
    process.env.COST_RATE_OPENAI_USD = '0.05'

    const reporter = createMockReporter()
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    const parsed = JSON.parse(exchange.body)
    assert.ok(parsed.cost_rates_usd)
    assert.equal(parsed.cost_rates_usd.groq, 0.025)
    assert.equal(parsed.cost_rates_usd.openai, 0.05)
    // Unset env vars should fall back to defaults
    assert.equal(parsed.cost_rates_usd.cerebras, 0.005)
  })

  // ── 8. CostReporter receives correct sinceMs ───────────────────────

  it('passes correct sinceMs to CostReporter based on days param', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'

    const reporter = createMockReporter()
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost?days=1')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    assert.equal(reporter.getCostReportCalls.length, 1)
    const expectedSince = Date.now() - 1 * 86_400_000
    const actualSince = reporter.getCostReportCalls[0].sinceMs!
    const toleranceMs = 5000
    assert.ok(
      Math.abs(actualSince - expectedSince) <= toleranceMs,
      `sinceMs should be ~1 day ago, got diff ${actualSince - expectedSince}ms`,
    )
  })

  // ── 9. JSON serialization of full CostReport ───────────────────────

  it('serializes full CostReport structure as JSON', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'

    const customReport: Partial<CostReport> = {
      total_requests: 5000,
      free_tier_requests: 4800,
      paid_tier_requests: 200,
      paid_tier_refused: 12,
      estimated_savings_usd: 99.99,
      per_provider: [
        {
          name: 'groq',
          requests: 3000,
          free_tier_requests: 2900,
          paid_tier_refused: 5,
          estimated_savings_usd: 30.0,
        },
        {
          name: 'openai',
          requests: 2000,
          free_tier_requests: 1900,
          paid_tier_refused: 7,
          estimated_savings_usd: 60.0,
        },
      ],
      daily: [
        { date: '2026-06-25', total_requests: 2500, savings_usd: 50.0 },
      ],
      generated_at: 1719300000000,
    }

    const reporter = createMockReporter(customReport)
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    const parsed = JSON.parse(exchange.body)
    assert.equal(parsed.total_requests, 5000)
    assert.equal(parsed.estimated_savings_usd, 99.99)
    assert.equal(parsed.paid_tier_refused, 12)
    assert.equal(parsed.per_provider.length, 2)
    assert.equal(parsed.per_provider[0].name, 'groq')
    assert.equal(parsed.per_provider[0].estimated_savings_usd, 30.0)
    assert.equal(parsed.daily.length, 1)
    assert.equal(parsed.daily[0].savings_usd, 50.0)
    assert.equal(parsed.generated_at, 1719300000000)
    assert.equal(parsed.query_days, 7)
    assert.ok(typeof parsed.cost_rates_usd === 'object')
  })

  // ── 10. 405 on non-GET methods ─────────────────────────────────────

  it('returns 405 for non-GET methods', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'

    const reporter = createMockReporter()
    const handler = createCostEndpointHandler(reporter)
    const exchange = createMockExchange('/v1/admin/cost', 'POST')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    assert.equal(exchange.statusCode, 405)
    const parsed = JSON.parse(exchange.body)
    assert.equal(parsed.error, 'Method not allowed')
  })

  // ── 11. Handler error propagates as 500 ────────────────────────────

  it('returns 500 when CostReporter throws', async () => {
    process.env.GATEWAY_COST_REPORTING = 'true'

    const failingReporter: CostReporter = {
      getCostReport: async () => {
        throw new Error('Database connection failed')
      },
    }

    const handler = createCostEndpointHandler(failingReporter)
    const exchange = createMockExchange('/v1/admin/cost')

    // @ts-expect-error — partial mocks are sufficient for the handler
    await handler(exchange.req as IncomingMessage, exchange.res as ServerResponse)

    assert.equal(exchange.statusCode, 500)
    const parsed = JSON.parse(exchange.body)
    assert.ok(parsed.error.includes('Database connection failed'))
  })
})
