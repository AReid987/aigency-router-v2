/**
 * Generic OpenAI-compatible client.
 * Can be instantiated with any base URL, apiKey, and auth header format.
 */
import { BaseProviderClient, type BaseClientOptions } from './base.js';
import type { ProviderInfo } from './types.js';

export interface OpenAIClientOptions extends Partial<BaseClientOptions> {
  providerId: string;
  baseUrl: string;
  authHeader: 'Authorization' | 'x-api-key';
  name?: string;
  models?: string[];
  free?: boolean;
}

export class OpenAIClient extends BaseProviderClient {
  private readonly _info: ProviderInfo;

  constructor(apiKey: string, options: OpenAIClientOptions) {
    super({
      apiKey,
      baseUrl: options.baseUrl,
      providerId: options.providerId,
      authHeader: options.authHeader,
      timeoutMs: options.timeoutMs,
      fetch: options.fetch,
    });
    this._info = {
      id: options.providerId,
      name: options.name ?? options.providerId,
      baseUrl: options.baseUrl,
      models: options.models ?? [],
      free: options.free,
      authHeader: options.authHeader,
    };
  }

  get info(): ProviderInfo {
    return this._info;
  }
}
