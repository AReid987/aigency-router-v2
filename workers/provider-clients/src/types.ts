/**
 * Common types for provider clients.
 * All providers accept OpenAI-compatible chat completion requests.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>;
  tool_choice?: string | { type: string; function: { name: string } };
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: string | null;
  }>;
}

export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  /** Models known to be supported (validated against /models if available) */
  models: string[];
  /** Free-tier or paid-tier markers */
  free?: boolean;
  /** Auth header format */
  authHeader: 'Authorization' | 'x-api-key';
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly provider: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
