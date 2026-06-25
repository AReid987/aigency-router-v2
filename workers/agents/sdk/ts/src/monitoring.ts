/**
 * Monitoring — get quota status from the Aigency gateway.
 */

import type { QuotaStatus } from './types.js'

/**
 * Fetch quota status from the /v1/admin/quota endpoint.
 */
export async function getQuotaStatus(
  baseURL: string,
  apiKey?: string,
): Promise<QuotaStatus> {
  const url = `${baseURL.replace(/\/+$/, '')}/v1/admin/quota`
  const headers: Record<string, string> = {}
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`

  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`Failed to fetch quota: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as QuotaStatus
}
