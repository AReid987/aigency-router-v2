/**
 * Provider clients — public entrypoint.
 * All clients are OpenAI-compatible chat completion APIs.
 */
export { BaseProviderClient } from './base.js';
export type { BaseClientOptions } from './base.js';
export { GroqClient } from './groq.js';
export { CerebrasClient } from './cerebras.js';
export { TogetherClient } from './together.js';
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
import type { BaseProviderClient } from './base.js';

/** Factory: build a client by provider id. */
export function createClient(
  providerId: 'groq' | 'cerebras' | 'together',
  apiKey: string,
  options?: Partial<ConstructorParameters<typeof GroqClient>[1]>,
): BaseProviderClient {
  switch (providerId) {
    case 'groq': return new GroqClient(apiKey, options);
    case 'cerebras': return new CerebrasClient(apiKey, options);
    case 'together': return new TogetherClient(apiKey, options);
    default: throw new Error(`unknown provider: ${providerId}`);
  }
}
