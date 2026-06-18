/**
 * Base client — abstract OpenAI-compatible HTTP client.
 * Uses undici for fetch with connection pooling and low-level control.
 */
import { request } from 'undici';
import type { ChatCompletionRequest, ChatCompletionResponse, ProviderInfo } from './types.js';
import { ProviderError } from './types.js';

export interface BaseClientOptions {
  apiKey: string;
  baseUrl: string;
  providerId: string;
  authHeader: 'Authorization' | 'x-api-key';
  /** Optional fetch timeout in ms (default 30000) */
  timeoutMs?: number;
  /** Optional fetch function override (for testing) */
  fetch?: typeof globalThis.fetch;
}

export abstract class BaseProviderClient {
  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly providerId: string;
  protected readonly authHeader: 'Authorization' | 'x-api-key';
  protected readonly timeoutMs: number;

  constructor(opts: BaseClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.providerId = opts.providerId;
    this.authHeader = opts.authHeader;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  abstract get info(): ProviderInfo;

  protected buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.authHeader === 'Authorization') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    } else {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  /**
   * Non-streaming chat completion.
   */
  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = this.buildHeaders({ 'content-type': 'application/json' });
    const res = await this.fetchJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...req, stream: false }),
    });
    return res as ChatCompletionResponse;
  }

  /**
   * Streaming chat completion — yields chunks.
   */
  async *chatStream(req: ChatCompletionRequest): AsyncGenerator<unknown> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = this.buildHeaders({ 'content-type': 'application/json' });
    const { body, statusCode } = await request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...req, stream: true }),
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });
    if (statusCode >= 400) {
      const errBody = await body.text();
      let parsed: unknown = errBody;
      try { parsed = JSON.parse(errBody); } catch { /* keep as string */ }
      throw new ProviderError(`HTTP ${statusCode} from ${this.providerId}`, statusCode, this.providerId, parsed);
    }
    let buffer = '';
    for await (const chunk of body) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch { /* skip malformed */ }
      }
    }
  }

  /**
   * List available models (OpenAI-compatible /models endpoint).
   */
  async listModels(): Promise<string[]> {
    const url = `${this.baseUrl}/models`;
    const headers = this.buildHeaders();
    try {
      const res = await this.fetchJson(url, { method: 'GET', headers });
      const data = res as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id) ?? [];
    } catch (err) {
      // Some providers don't support /models
      if (err instanceof ProviderError && err.status === 404) return [];
      throw err;
    }
  }

  protected async fetchJson(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<unknown> {
    const { body, statusCode } = await request(url, {
      method: init.method as 'GET' | 'POST',
      headers: init.headers,
      body: init.body,
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });
    const text = await body.text();
    if (statusCode >= 400) {
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep as string */ }
      throw new ProviderError(`HTTP ${statusCode} from ${this.providerId}`, statusCode, this.providerId, parsed);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return text; }
  }
}
