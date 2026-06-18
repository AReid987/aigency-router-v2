/**
 * Groq client — high-speed inference API.
 * OpenAI-compatible. Free tier available.
 */
import { BaseProviderClient, type BaseClientOptions } from './base.js';
import type { ProviderInfo } from './types.js';

const GROQ_INFO: ProviderInfo = {
  id: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  models: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'llama3-70b-8192',
    'llama3-8b-8192',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
    'whisper-large-v3',
  ],
  free: true,
  authHeader: 'Authorization',
};

export class GroqClient extends BaseProviderClient {
  constructor(apiKey: string, options: Partial<BaseClientOptions> = {}) {
    super({
      apiKey,
      baseUrl: GROQ_INFO.baseUrl,
      providerId: GROQ_INFO.id,
      authHeader: GROQ_INFO.authHeader,
      ...options,
    });
  }

  get info(): ProviderInfo { return GROQ_INFO; }
}
