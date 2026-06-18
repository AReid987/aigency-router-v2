/**
 * Cerebras client — wafer-scale inference.
 * OpenAI-compatible. Free tier available.
 */
import { BaseProviderClient, type BaseClientOptions } from './base.js';
import type { ProviderInfo } from './types.js';

const CEREBRAS_INFO: ProviderInfo = {
  id: 'cerebras',
  name: 'Cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
  models: [
    'llama-3.3-70b',
    'llama-3.1-70b',
    'llama-3.1-8b',
    'qwen-2.5-72b',
    'qwen-2.5-32b',
    'llama-3.3-70b-cerebras',
  ],
  free: true,
  authHeader: 'Authorization',
};

export class CerebrasClient extends BaseProviderClient {
  constructor(apiKey: string, options: Partial<BaseClientOptions> = {}) {
    super({
      apiKey,
      baseUrl: CEREBRAS_INFO.baseUrl,
      providerId: CEREBRAS_INFO.id,
      authHeader: CEREBRAS_INFO.authHeader,
      ...options,
    });
  }

  get info(): ProviderInfo { return CEREBRAS_INFO; }
}
