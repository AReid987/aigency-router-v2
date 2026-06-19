/**
 * E2E smoke test using the channel-based HTTP protocol.
 * The real iii-sdk worker uses the http() wrapper which requires the
 * InternalHttpRequest format with `response: StreamChannelRef`.
 */
import { test } from 'node:test';
import { Engine } from './engine.js';
import { registerWorker } from 'iii-sdk';

test('E2E: HTTP request routed through engine to real iii-sdk worker via channel protocol', async () => {
  const engine = new Engine({ wsPort: 0, httpPort: 0 });
  await engine.start();
  const wsPort = (engine as any).boundHttpPort;
  const httpPort = (engine as any).httpServer.address().port;

  try {
    const iii = registerWorker(`ws://127.0.0.1:${wsPort}`, { workerName: 'smoke-gateway' });

    iii.registerFunction('gateway::chat_completions', async (req: any) => {
      // The SDK's resolveChannelValue has already converted `response` from a StreamChannelRef
      // into a ChannelWriter that connects to the engine's channel.
      const responseWriter = req.response;
      if (!responseWriter || typeof responseWriter.sendMessage !== 'function') {
        throw new Error('no response channel writer');
      }
      responseWriter.sendMessage(JSON.stringify({ type: 'set_status', status_code: 200 }));
      responseWriter.sendMessage(JSON.stringify({ type: 'set_headers', headers: { 'content-type': 'application/json' } }));
      responseWriter.sendMessage(JSON.stringify({
        received_model: req.body?.model,
        received_messages_count: Array.isArray(req.body?.messages) ? req.body.messages.length : 0,
        worker: 'smoke-gateway',
      }));
      responseWriter.close();
    });

    iii.registerTrigger({
      type: 'http',
      function_id: 'gateway::chat_completions',
      config: { api_path: '/v1/chat/completions', http_method: 'POST' },
    });

    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`http://127.0.0.1:${httpPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    if (res.status !== 200) {
      const text = await res.text();
      throw new Error(`expected 200, got ${res.status}: ${text}`);
    }
    const body = await res.json() as { received_model: string; received_messages_count: number; worker: string };
    if (body.received_model !== 'llama-3.3-70b') throw new Error('bad model: ' + body.received_model);
    if (body.received_messages_count !== 1) throw new Error('bad msg count: ' + body.received_messages_count);
    if (body.worker !== 'smoke-gateway') throw new Error('bad worker: ' + body.worker);

    await iii.shutdown();
  } finally {
    await engine.shutdown();
  }
});

test('E2E: HTTP request returns proper headers from worker', async () => {
  const engine = new Engine({ wsPort: 0, httpPort: 0 });
  await engine.start();
  const wsPort = (engine as any).boundHttpPort;
  const httpPort = (engine as any).httpServer.address().port;

  try {
    const iii = registerWorker(`ws://127.0.0.1:${wsPort}`, { workerName: 'header-test' });

    iii.registerFunction('headers::test', async (req: any) => {
      const responseWriter = req.response;
      responseWriter.sendMessage(JSON.stringify({ type: 'set_status', status_code: 201 }));
      responseWriter.sendMessage(JSON.stringify({ type: 'set_headers', headers: { 'x-custom-header': 'engine-test', 'content-type': 'application/json' } }));
      responseWriter.sendMessage(JSON.stringify({ ok: true }));
      responseWriter.close();
    });

    iii.registerTrigger({
      type: 'http',
      function_id: 'headers::test',
      config: { api_path: '/test/headers', http_method: 'POST' },
    });

    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`http://127.0.0.1:${httpPort}/test/headers`, {
      method: 'POST',
      body: JSON.stringify({ x: 1 }),
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    assert(res.headers.get('x-custom-header') === 'engine-test');
    const body = await res.json() as { ok: boolean };
    assert(body.ok === true);

    await iii.shutdown();
  } finally {
    await engine.shutdown();
  }
});

import assert from 'node:assert';
