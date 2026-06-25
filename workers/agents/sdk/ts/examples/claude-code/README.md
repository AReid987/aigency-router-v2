# Claude Code integration with Aigency Router

Use the Aigency Router as the API backend for Claude Code, routing
requests through the Aigency gateway for brain classification and
multi-provider failover.

## Prerequisites

- Node.js 18+ (for `fetch` support)
- A running Aigency Gateway (default: http://localhost:8787)

## Quick Start

### 1. Install the Aigency SDK

```bash
cd workers/agents/sdk/ts
npm install
npm run build
```

### 2. Set environment variables

```bash
export AIGENCY_BASE_URL="http://localhost:8787"
export AIGENCY_API_KEY="sk-aigency-your-key"
```

### 3. Verify connectivity

Run a quick test with the SDK:

```bash
npx tsx -e "
import { AigencyClient } from './src/index.ts'

const client = new AigencyClient(
  process.env.AIGENCY_BASE_URL ?? 'http://localhost:8787',
  process.env.AIGENCY_API_KEY
)

const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Say hello in one word' }],
})

if ('choices' in response) {
  console.log('Response:', response.choices[0].message.content)
}
"
```

You should see a response like `Hello!` printed to stdout.

### 4. Point Claude Code at the Aigency Gateway

Set the API base URL in your Claude Code configuration:

```bash
# In your Claude Code config (claude_code_config.json or environment):
# CLAUDE_CODE_API_BASE_URL=$AIGENCY_BASE_URL
# CLAUDE_CODE_API_KEY=$AIGENCY_API_KEY
```

When using the SDK programmatically with Claude Code:

```typescript
import { AigencyClient } from '@aigency/sdk'

const client = new AigencyClient(
  process.env.AIGENCY_BASE_URL ?? 'http://localhost:8787',
  process.env.AIGENCY_API_KEY
)

// Non-streaming
const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }],
})

// Streaming
const stream = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true,
})

for await (const chunk of stream as AsyncIterable<any>) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
}
```

## Configuration File

Copy `config.example.json` to `config.json`, fill in your values:

```json
{
  "AIGENCY_BASE_URL": "http://localhost:8787",
  "AIGENCY_API_KEY": "sk-aigency-your-key-here"
}
```

## Automatic Retry

The SDK automatically retries on 5xx errors with exponential backoff
(100ms, 200ms, 400ms default). Configure via `AigencyClientOptions`:

```typescript
const client = new AigencyClient(BASE_URL, API_KEY, {
  maxRetries: 5,
  retryDelayMs: 200,
})
```

## AbortSignal support

```typescript
const controller = new AbortController()
setTimeout(() => controller.abort(), 5000)

try {
  const response = await client.chat.completions.create(
    { model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] },
    { signal: controller.signal }
  )
} catch (err) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    console.log('Request was cancelled')
  }
}
```
