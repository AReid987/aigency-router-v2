/**
 * Provider client tests — use a local mock HTTP server (no external API calls).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { GroqClient } from './groq.js';
import { CerebrasClient } from './cerebras.js';
import { TogetherClient } from './together.js';
import { createClient } from './index.js';
import { ProviderError } from './types.js';

interface MockResponse {
  status?: number;
  body?: unknown;
  contentType?: string;
  /** If set, body is sent as raw bytes (for SSE) */
  rawBody?: string;
}

let server: Server;
let baseUrl: string;
const recordings: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
let mocks: Map<string, MockResponse> = new Map();

function registerMock(path: string, resp: MockResponse): void {
  mocks.set(path, resp);
}

function clearMocks(): void { mocks.clear(); recordings.length = 0; }

before(async () => {
  await new Promise<void>((res) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const url = req.url ?? '/';
        recordings.push({
          method: req.method ?? 'GET',
          path: url,
          headers: req.headers as any,
          body,
        });
        const mock = mocks.get(url.split('?')[0]);
        if (!mock) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no mock for ' + url }));
          return;
        }
        if (mock.rawBody) {
          res.writeHead(mock.status ?? 200, { 'content-type': mock.contentType ?? 'text/event-stream' });
          res.end(mock.rawBody);
          return;
        }
        res.writeHead(mock.status ?? 200, { 'content-type': mock.contentType ?? 'application/json' });
        res.end(typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      res();
    });
  });
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

describe('GroqClient', () => {
  test('non-streaming chat returns parsed response', async () => {
    clearMocks();
    registerMock('/openai/v1/chat/completions', {
      body: {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1700000000,
        model: 'llama-3.3-70b-versatile',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello from Groq!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });
    const client = new GroqClient('test-api-key', { baseUrl: baseUrl + '/openai/v1' });
    const res = await client.chat({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.strictEqual(res.id, 'chatcmpl-1');
    assert.strictEqual(res.choices[0].message.content, 'Hello from Groq!');
    assert.strictEqual(res.usage?.total_tokens, 15);

    // Verify request was made correctly
    const rec = recordings[0];
    assert.strictEqual(rec.method, 'POST');
    assert.strictEqual(rec.path, '/openai/v1/chat/completions');
    assert.strictEqual(rec.headers['authorization'], 'Bearer test-api-key');
    assert.strictEqual(rec.headers['content-type'], 'application/json');
    const sentBody = JSON.parse(rec.body);
    assert.strictEqual(sentBody.model, 'llama-3.3-70b-versatile');
    assert.deepStrictEqual(sentBody.messages, [{ role: 'user', content: 'hi' }]);
    assert.strictEqual(sentBody.stream, false);
  });

  test('streaming chat yields parsed chunks', async () => {
    clearMocks();
    const sseBody = [
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    registerMock('/openai/v1/chat/completions', { rawBody: sseBody, contentType: 'text/event-stream' });
    const client = new GroqClient('test-api-key', { baseUrl: baseUrl + '/openai/v1' });
    const chunks = [];
    for await (const chunk of client.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }
    assert.strictEqual(chunks.length, 3);
    const content = chunks.map((c: any) => c.choices[0].delta.content ?? '').join('');
    assert.strictEqual(content, 'Hello world');
  });

  test('error response throws ProviderError with status and body', async () => {
    clearMocks();
    registerMock('/openai/v1/chat/completions', {
      status: 401,
      body: { error: { message: 'Invalid API key', type: 'auth_error' } },
    });
    const client = new GroqClient('bad-key', { baseUrl: baseUrl + '/openai/v1' });
    await assert.rejects(
      async () => client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      (err: Error) => err instanceof ProviderError && (err as any).status === 401 && (err as any).provider === 'groq',
    );
  });
});

describe('CerebrasClient', () => {
  test('uses cerebras base URL and Authorization header', async () => {
    clearMocks();
    registerMock('/v1/chat/completions', {
      body: { id: 'c1', object: 'chat.completion', created: 1, model: 'llama-3.3-70b', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] },
    });
    const client = new CerebrasClient('cb-key', { baseUrl: baseUrl + '/v1' });
    const res = await client.chat({ model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(res.choices[0].message.content, 'hi');
    assert.strictEqual(recordings[0].headers['authorization'], 'Bearer cb-key');
  });
});

describe('TogetherClient', () => {
  test('uses together base URL and Authorization header', async () => {
    clearMocks();
    registerMock('/v1/chat/completions', {
      body: { id: 't1', object: 'chat.completion', created: 1, model: 'meta-llama/Llama-3.3-70B', choices: [{ index: 0, message: { role: 'assistant', content: 'tg' }, finish_reason: 'stop' }] },
    });
    const client = new TogetherClient('tg-key', { baseUrl: baseUrl + '/v1' });
    const res = await client.chat({ model: 'meta-llama/Llama-3.3-70B', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(res.choices[0].message.content, 'tg');
    assert.strictEqual(recordings[0].headers['authorization'], 'Bearer tg-key');
  });
});

describe('createClient factory', () => {
  test('returns correct client type by id', () => {
    const groq = createClient('groq', 'k');
    const cb = createClient('cerebras', 'k');
    const tg = createClient('together', 'k');
    assert.strictEqual(groq.info.id, 'groq');
    assert.strictEqual(cb.info.id, 'cerebras');
    assert.strictEqual(tg.info.id, 'together');
  });

  test('throws for unknown provider', () => {
    assert.throws(() => createClient('openai' as any, 'k'), /unknown provider/);
  });
});

describe('listModels', () => {
  test('returns model ids from /models endpoint', async () => {
    clearMocks();
    registerMock('/openai/v1/models', {
      body: { data: [{ id: 'model-a' }, { id: 'model-b' }] },
    });
    const client = new GroqClient('k', { baseUrl: baseUrl + '/openai/v1' });
    const models = await client.listModels();
    assert.deepStrictEqual(models, ['model-a', 'model-b']);
  });

  test('returns empty array when /models is 404', async () => {
    clearMocks();
    registerMock('/openai/v1/models', { status: 404, body: { error: 'not found' } });
    const client = new GroqClient('k', { baseUrl: baseUrl + '/openai/v1' });
    const models = await client.listModels();
    assert.deepStrictEqual(models, []);
  });
});
