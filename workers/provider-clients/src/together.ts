/**
 * Together AI client — open-source model hub.
 * OpenAI-compatible. Pay-per-token.
 */
import { BaseProviderClient, type BaseClientOptions } from './base.js';
import type { ProviderInfo } from './types.js';

const TOGETHER_INFO: ProviderInfo = {
  id: 'together',
  name: 'Together AI',
  baseUrl: 'https://api.together.xyz/v1',
  models: [
    'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    'mistralai/Mixtral-8x7B-Instruct-v0.1',
    'Qwen/Qwen2.5-72B-Instruct-Turbo',
    'Qwen/Qwen2.5-7B-Instruct-Turbo',
    'google/gemma-2-9b-it',
  ],
  free: false,
  authHeader: 'Authorization',
};

export class TogetherClient extends BaseProviderClient {
  constructor(apiKey: string, options: Partial<BaseClientOptions> = {}) {
    super({
      apiKey,
      baseUrl: TOGETHER_INFO.baseUrl,
      providerId: TOGETHER_INFO.id,
      authHeader: TOGETHER_INFO.authHeader,
      ...options,
    });
  }

  get info(): ProviderInfo { return TOGETHER_INFO; }
}
