/**
 * E2E smoke test: bring up the engine, connect the actual iii-sdk worker,
 * register an HTTP trigger, and verify an HTTP request gets routed + responded.
 */
import { test } from 'node:test';
import { Engine } from './engine.js';
import { registerWorker } from 'iii-sdk';

test('E2E: HTTP request routed through engine to real iii-sdk worker', async () => {
  const engine = new Engine({ wsPort: 0, httpPort: 0 });
  await engine.start();
  const wsPort = (engine as any).wsServer.address().port;
  const httpPort = (engine as any).httpServer.address().port;

  try {
    // Start a real iii-sdk worker
    const iii = registerWorker(`ws://127.0.0.1:${wsPort}`, { workerName: 'smoke-gateway' });

    // Register an HTTP handler that uses the simple { status, headers, body } protocol
    // (bypasses the SDK's `http()` channel framework for the smoke test)
    iii.registerFunction('smoke::http', async (req: any) => {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          received_model: req.body?.model,
          received_messages_count: Array.isArray(req.body?.messages) ? req.body.messages.length : 0,
          worker: 'smoke-gateway',
        }),
      };
    });

    // Register an HTTP trigger for /v1/chat/completions → smoke::http
    iii.registerTrigger({
      type: 'http',
      function_id: 'smoke::http',
      config: { api_path: '/v1/chat/completions', http_method: 'POST' },
    });

    // Wait for everything to register
    await new Promise((r) => setTimeout(r, 500));

    // Verify engine sees the worker and trigger
    const workers = await engine.trigger<any[]>('engine::workers::list');
    const smokeWorker = workers.find((w: any) => w.worker_name === 'smoke-gateway');
    if (!smokeWorker) throw new Error('smoke-gateway not registered: ' + JSON.stringify(workers));

    // Hit the HTTP endpoint
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
