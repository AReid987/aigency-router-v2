/**
 * @aigency/sdk — TypeScript SDK for the Aigency Router.
 *
 * Provides an OpenAI-compatible client for chat completions
 * (non-streaming and SSE streaming), model listing, and quota monitoring.
 */

export { AigencyClient } from './client.js'
export { AigencyHttpError } from './client.js'
export { getQuotaStatus } from './monitoring.js'

export type {
  Role,
  ChatCompletionMessageParam,
  ChatCompletionRequestParam,
  ChatCompletionMessage,
  Choice,
  Usage,
  ChatCompletionResponse,
  Delta,
  ChunkChoice,
  ChatCompletionChunk,
  Model,
  ProviderQuota,
  QuotaStatus,
  AigencyError,
} from './types.ts'
