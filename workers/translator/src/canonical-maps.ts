/**
 * Canonical model name → provider-specific model string array.
 *
 * Order within each array defines failover priority:
 * index 0 = primary provider, index 1 = first failover, etc.
 *
 * Format: "provider/model-id" where provider matches the key
 * used by the gateway's provider routing layer.
 */
export const CANONICAL_MAP: Record<string, string[]> = {
  'openrouter/free': ['openrouter/free'],
  'mistral-large-latest': ['openrouter/mistralai/mistral-large-2411', 'groq/llama-3.3-70b-versatile'],
  'mistral-small-latest': ['openrouter/mistralai/mistral-small-2409', 'groq/llama-3.1-8b-instant'],
  'llama3': [
    'groq/llama-3.1-8b-instant',
    'together/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  ],
  'llama3-70b': [
    'groq/llama-3.3-70b-versatile',
    'together/meta-llama/Llama-3.3-70B-Instruct-Turbo',
  ],
  'gpt-oss': [
    'cerebras/gpt-oss-120b',
    'groq/openai/gpt-oss-20b',
    'together/openai/gpt-oss-120b',
  ],
  'deepseek-v4-flash': ['openrouter/deepseek/deepseek-chat', 'groq/llama-3.1-8b-instant'],
  'deepseek-v4-pro': ['openrouter/deepseek/deepseek-r1', 'groq/llama-3.3-70b-versatile'],
}
