/**
 * Provider clients — public entrypoint.
 * All clients are OpenAI-compatible chat completion APIs.
 */
export { BaseProviderClient } from './base.js';
export type { BaseClientOptions } from './base.js';
export { GroqClient } from './groq.js';
export { CerebrasClient } from './cerebras.js';
export { TogetherClient } from './together.js';
export { OpenAIClient } from './openai-compatible.js';
export type {
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ProviderInfo,
} from './types.js';
export { ProviderError } from './types.js';

import { GroqClient } from './groq.js';
import { CerebrasClient } from './cerebras.js';
import { TogetherClient } from './together.js';
import { OpenAIClient } from './openai-compatible.js';
import type { BaseProviderClient } from './base.js';

/** All supported provider IDs */
export type ProviderId =
  | 'groq'
  | 'cerebras'
  | 'together'
  | 'openrouter'
  | 'freemodel'
  | 'mistral'
  | 'command-code'
  | 'llm7';

/**
 * Provider base URLs.
 * Kept in a single map so the factory stays DRY.
 */
const PROVIDER_BASE_URLS: Record<Exclude<ProviderId, 'groq' | 'cerebras' | 'together'>, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  freemodel: 'https://api.freemodel.dev/v1',
  mistral: 'https://api.mistral.ai/v1',
  'command-code': 'https://api.anthropic.com/v1',
  llm7: 'https://llm7.io/api/v1',
};

/** Factory: build a client by provider id. */
export function createClient(
  providerId: ProviderId,
  apiKey: string,
  options?: Partial<import('./base.js').BaseClientOptions>,
): BaseProviderClient {
  switch (providerId) {
    case 'groq':
      return new GroqClient(apiKey, options);
    case 'cerebras':
      return new CerebrasClient(apiKey, options);
    case 'together':
      return new TogetherClient(apiKey, options);
    case 'openrouter':
    case 'freemodel':
    case 'mistral':
    case 'command-code':
    case 'llm7':
      return new OpenAIClient(apiKey, {
        providerId,
        baseUrl: PROVIDER_BASE_URLS[providerId],
        authHeader: 'Authorization',
        ...options,
      });
    default:
      // Exhaustiveness check — TypeScript narrows to `never` here
      throw new Error(`unknown provider: ${providerId satisfies never}`);
  }
}
