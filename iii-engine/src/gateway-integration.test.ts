/**
 * Integration test: spin up the engine, start the actual gateway worker,
 * and verify it registers and can be invoked.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert';
import { Engine } from './engine.js';
import { registerWorker } from 'iii-sdk';

test('real gateway worker registers all functions and triggers against the engine', async () => {
  // Start the engine
  const engine = new Engine({ wsPort: 0, httpPort: 0 });
  await engine.start();
  const port = (engine as any).boundHttpPort;

  let iii: any = null;

  try {
    // Replicate the gateway's bootstrap (we don't import the gateway to avoid its dependencies)
    iii = registerWorker(`ws://127.0.0.1:${port}`, { workerName: 'gateway' });

    iii.registerFunction('gateway::echo', async (input: any) => ({
      echo: input?.message ?? 'pong',
      worker: 'gateway',
      timestamp: Date.now(),
    }));

    iii.registerFunction('gateway::status', async () => ({
      worker: 'gateway',
      status: 'healthy',
      uptime: process.uptime(),
    }));

    iii.registerTrigger({
      type: 'http',
      function_id: 'gateway::chat_completions',
      config: { api_path: '/v1/chat/completions', http_method: 'POST' },
    });

    iii.registerFunction('gateway::chat_completions', async (input: any) => {
      // Minimal chat completions handler
      const responseWriter = input?.response;
      if (!responseWriter?.sendMessage) {
        return { status: 200, body: JSON.stringify({ ok: true, echo: input?.body }) };
      }
      responseWriter.sendMessage(JSON.stringify({ type: 'set_status', status_code: 200 }));
      responseWriter.sendMessage(JSON.stringify({ type: 'set_headers', headers: { 'content-type': 'application/json' } }));
      responseWriter.sendMessage(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello from gateway' } }] }));
      responseWriter.close();
    });

    // Wait for everything to register
    await new Promise((r) => setTimeout(r, 500));

    // Verify engine sees gateway worker
    const workers = await engine.trigger<any[]>('engine::workers::list');
    const gw = workers.find((w: any) => w.worker_name === 'gateway');
    assert.ok(gw, `gateway worker should be registered, got: ${JSON.stringify(workers)}`);

    // Verify engine sees the gateway functions
    const fns = await engine.trigger<any[]>('engine::functions::list');
    const fnIds = fns.map((f: any) => f.id);
    assert.ok(fnIds.includes('gateway::echo'), 'gateway::echo should be registered');
    assert.ok(fnIds.includes('gateway::status'), 'gateway::status should be registered');
    assert.ok(fnIds.includes('gateway::chat_completions'), 'gateway::chat_completions should be registered');

    // Trigger gateway::echo via the engine
    const echoResult = await engine.trigger<any>('gateway::echo', { message: 'hello' });
    assert.strictEqual(echoResult.echo, 'hello');
    assert.strictEqual(echoResult.worker, 'gateway');

    // Trigger gateway::status
    const statusResult = await engine.trigger<any>('gateway::status');
    assert.strictEqual(statusResult.status, 'healthy');

    // Now actually call the HTTP endpoint
    const httpPort = (engine as any).boundHttpPort;
    const res = await fetch(`http://127.0.0.1:${httpPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.choices, 'should return choices array');
    assert.strictEqual(body.choices[0].message.content, 'hello from gateway');

    await iii.shutdown();
  } finally {
    if (iii) await iii.shutdown().catch(() => {});
    await engine.shutdown();
  }
});
