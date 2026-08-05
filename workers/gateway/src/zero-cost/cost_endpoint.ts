/**
 * Cost endpoint — GET /v1/admin/cost
 *
 * Returns a JSON CostReport from the CostReporter.
 * Gated on GATEWAY_COST_REPORTING=true (404 when off).
 * Supports ?days=N query param (default 7, range 1-365).
 * Cost rates are configured via environment variables at module init.
 *
 * Integration: consumed by S03 (e2e test). Independent endpoint;
 *   reads from the S01 CostReporter interface.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

// ── CostReport type (mirrors S01 contract) ─────────────────────────────

export interface CostPerProvider {
  name: string
  requests: number
  free_tier_requests: number
  paid_tier_refused: number
  estimated_savings_usd: number
}

export interface CostDailyBucket {
  date: string
  total_requests: number
  savings_usd: number
}

export interface CostReport {
  total_requests: number
  free_tier_requests: number
  paid_tier_requests: number
  paid_tier_refused: number
  estimated_savings_usd: number
  per_provider: CostPerProvider[]
  daily?: CostDailyBucket[]
  generated_at: number
}

// ── CostReporter interface (structural — matches S01's CostReporter) ───

export interface CostReporter {
  getCostReport(options?: {
    sinceMs?: number
    untilMs?: number
    dailyBuckets?: boolean
  }): Promise<CostReport>
}

// ── Default cost rates (loaded from env at module init) ────────────────

const DEFAULT_COST_RATES: Record<string, number> = {
  groq: 0.01,
  cerebras: 0.005,
  together: 0.005,
  openai: 0.03,
  anthropic: 0.025,
}

function loadCostRatesFromEnv(): Record<string, number> {
  const rates: Record<string, number> = {}
  const envMap: Record<string, string> = {
    COST_RATE_GROQ_USD: 'groq',
    COST_RATE_CEREBRAS_USD: 'cerebras',
    COST_RATE_TOGETHER_USD: 'together',
    COST_RATE_OPENAI_USD: 'openai',
    COST_RATE_ANTHROPIC_USD: 'anthropic',
  }

  for (const [envKey, provider] of Object.entries(envMap)) {
    const raw = process.env[envKey]
    if (raw !== undefined && raw !== '') {
      const parsed = parseFloat(raw)
      if (!Number.isNaN(parsed) && parsed >= 0) {
        rates[provider] = parsed
      } else {
        rates[provider] = DEFAULT_COST_RATES[provider] ?? 0
      }
    } else {
      rates[provider] = DEFAULT_COST_RATES[provider] ?? 0
    }
  }

  return rates
}

// ── Query param parsing ────────────────────────────────────────────────

/**
 * Parse the ?days=N query parameter from the request URL.
 * Returns an integer in [1, 365]. Defaults to 7 when absent or invalid.
 */
function parseDaysParam(url: string | undefined): number {
  if (!url) return 7

  const idx = url.indexOf('?')
  if (idx === -1) return 7

  const search = url.slice(idx + 1)
  const params = new URLSearchParams(search)
  const raw = params.get('days')
  if (raw === null) return 7

  const parsed = parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 365) return 7

  return parsed
}

// ── Endpoint handler factory ───────────────────────────────────────────

/**
 * Create an HTTP handler for GET /v1/admin/cost.
 *
 * @param costReporter - A CostReporter instance with getCostReport().
 * @returns A (req, res) handler compatible with node:http.createServer.
 */
export function createCostEndpointHandler(costReporter: CostReporter) {
  const costRates = loadCostRatesFromEnv()

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Gate: GATEWAY_COST_REPORTING must be 'true'
    if (process.env.GATEWAY_COST_REPORTING !== 'true') {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    // Only accept GET
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    try {
      const days = parseDaysParam(req.url)
      const sinceMs = Date.now() - days * 86_400_000

      const report = await costReporter.getCostReport({ sinceMs })

      // Attach the loaded cost rates to the response for transparency
      const responseBody = {
        ...report,
        cost_rates_usd: costRates,
        query_days: days,
      }

      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(responseBody))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: `Cost report failed: ${message}` }))
    }
  }
}
