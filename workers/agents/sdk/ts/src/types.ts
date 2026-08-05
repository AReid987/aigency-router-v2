/**
 * OpenAI-compatible types for the Aigency SDK.
 * Minimal set — no dependency on the real `openai` package.
 */

// ── Request Types ──────────────────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatCompletionMessageParam {
  role: Role
  content: string
}

export interface ChatCompletionRequestParam {
  model: string
  messages: ChatCompletionMessageParam[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
}

// ── Response Types ─────────────────────────────────────────────────────

export interface ChatCompletionMessage {
  role: string
  content: string
}

export interface Choice {
  index: number
  message: ChatCompletionMessage
  finish_reason: string
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Choice[]
  usage?: Usage
}

// ── SSE Chunk Types (streaming) ────────────────────────────────────────

export interface Delta {
  content?: string
  role?: string
}

export interface ChunkChoice {
  index: number
  delta: Delta
  finish_reason: string | null
}

export interface ChatCompletionChunk {
  id: string
  object: string
  created: number
  model: string
  choices: ChunkChoice[]
}

// ── Model Types ────────────────────────────────────────────────────────

export interface Model {
  id: string
  object: string
  created: number
  owned_by: string
}

// ── Monitoring Types ───────────────────────────────────────────────────

export interface ProviderQuota {
  name: string
  current: number
  limit: number
  utilization_pct: number
  projected_exhaustion_at: number | null
}

export interface QuotaStatus {
  providers: ProviderQuota[]
}

// ── Error Types ────────────────────────────────────────────────────────

export interface AigencyError {
  error: {
    message: string
    type: string
    code?: string
  }
}
