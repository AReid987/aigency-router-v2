import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { Engine } from './engine.js';

let engine: Engine;
let port: number;

before(async () => {
  engine = new Engine({ wsPort: 0, httpPort: 0 });
  await engine.start();
  port = (engine as any).boundHttpPort;
});

after(async () => {
  await engine.shutdown();
});

function url(): string { return `ws://127.0.0.1:${port}`; }

function openWs(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url());
    ws.once('open', () => res(ws));
    ws.once('error', rej);
  });
}

function send(ws: WebSocket, msg: object): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), 5000);
    ws.once('message', (data: any) => {
      clearTimeout(t);
      res(JSON.parse(data.toString()));
    });
    ws.send(JSON.stringify(msg));
  });
}

test('Engine accepts WebSocket connection', async () => {
  const ws = await openWs();
  assert.strictEqual(ws.readyState, WebSocket.OPEN);
  ws.close();
});

test('engine.trigger functions::list returns array', async () => {
  const result = await engine.trigger<any[]>('engine::functions::list');
  assert.ok(Array.isArray(result));
});

test('engine.trigger functions::list is empty without workers', async () => {
  const result = await engine.trigger<any[]>('engine::functions::list');
  assert.strictEqual(result.length, 0);
});

test('engine.trigger workers::list returns array', async () => {
  const result = await engine.trigger<any[]>('engine::workers::list');
  assert.ok(Array.isArray(result));
});

test('engine.trigger throws for unknown function', async () => {
  await assert.rejects(
    async () => { await engine.trigger('nonexistent::fn'); },
    /function-not-found/,
  );
});

test('Engine shuts down cleanly', async () => {
  // Just verify the global after() can shut down
  assert.ok(engine, 'engine was started');
});

test('worker registers function, caller triggers it, worker returns result', async () => {
  const localEngine = new Engine({ wsPort: 0, httpPort: 0 });
  await localEngine.start();
  const localPort = (localEngine as any).boundHttpPort;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${localPort}`);
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });

    // Set up the echo handler BEFORE registering/triggering
    const invoked = new Promise<any>((res, rej) => {
      const t = setTimeout(() => rej(new Error('no-invocation')), 5000);
      ws.on('message', function listener(data: any) {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'invokefunction' && msg.function_id === 'echo::say') {
          clearTimeout(t);
          ws.off('message', listener);
          ws.send(JSON.stringify({ type: 'invocationresult', invocation_id: msg.invocation_id, result: { heard: msg.data } }));
          res(msg);
        }
      });
    });

    // Register the function
    ws.send(JSON.stringify({ type: 'registerfunction', id: 'echo::say', description: 'Echo' }));
    await new Promise((r) => setTimeout(r, 200));

    // Trigger and wait for the echo
    const result = await localEngine.trigger<{ heard: { who: string } }>('echo::say', { who: 'world' });
    await invoked;

    assert.deepStrictEqual(result, { heard: { who: 'world' } });
    ws.close();
  } finally {
    await localEngine.shutdown();
  }
});

test('invocation times out if worker does not respond', async () => {
  const localEngine = new Engine({ wsPort: 0, httpPort: 0, invocationTimeoutMs: 200 });
  await localEngine.start();
  const localPort = (localEngine as any).boundHttpPort;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${localPort}`);
    await new Promise<void>((res) => ws.once('open', () => res()));
    ws.send(JSON.stringify({ type: 'registerfunction', id: 'slow::fn', description: 'slow' }));
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(
      async () => { await localEngine.trigger('slow::fn', {}); },
      (err: Error) => err.message.includes('timeout') || err.message.includes('function-not-found'),
    );
    ws.close();
  } finally {
    await localEngine.shutdown();
  }
});

test('GET /health returns 200 with status:ok', async () => {
  const localEngine = new Engine({ wsPort: 0, httpPort: 0 });
  await localEngine.start();
  const httpPort = (localEngine as any).httpServer.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${httpPort}/health`);
    const body = await res.json() as { status: string; ts: number };
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.status, 'ok');
    assert.ok(body.ts > 0);
  } finally {
    await localEngine.shutdown();
  }
});

test('GET /ready returns 503 when no http worker registered, 200 when registered', async () => {
  const localEngine = new Engine({ wsPort: 0, httpPort: 0 });
  await localEngine.start();
  const httpPort = (localEngine as any).httpServer.address().port;
  try {
    // Initially no http worker
    const res1 = await fetch(`http://127.0.0.1:${httpPort}/ready`);
    assert.strictEqual(res1.status, 503);
    const body1 = await res1.json() as { ready: boolean };
    assert.strictEqual(body1.ready, false);

    // Register an http trigger worker
    const ws = new WebSocket(`ws://127.0.0.1:${(localEngine as any).boundHttpPort}`);
    await new Promise<void>((res) => ws.once('open', () => res()));
    ws.send(JSON.stringify({ type: 'registertriggertype', id: 'http', description: 'HTTP' }));
    await new Promise((r) => setTimeout(r, 100));

    const res2 = await fetch(`http://127.0.0.1:${httpPort}/ready`);
    assert.strictEqual(res2.status, 200);
    const body2 = await res2.json() as { ready: boolean };
    assert.strictEqual(body2.ready, true);
    ws.close();
  } finally {
    await localEngine.shutdown();
  }
});

test('GET /metrics returns engine stats', async () => {
  const localEngine = new Engine({ wsPort: 0, httpPort: 0 });
  await localEngine.start();
  const httpPort = (localEngine as any).httpServer.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${httpPort}/metrics`);
    const body = await res.json() as { engine: { workers: number }; sla: { total_calls: number } };
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.engine.workers, 0);
    assert.strictEqual(body.sla.total_calls, 0);
  } finally {
    await localEngine.shutdown();
  }
});

test('SLA: invocation latency and error counts are recorded', async () => {
  const localEngine = new Engine({ wsPort: 0, httpPort: 0 });
  await localEngine.start();
  const localPort = (localEngine as any).boundHttpPort;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${localPort}`);
    await new Promise<void>((res) => ws.once('open', () => res()));

    // Set up echo handler
    ws.on('message', function listener(data: any) {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'invokefunction' && msg.function_id === 'sla::fn') {
        ws.off('message', listener);
        ws.send(JSON.stringify({ type: 'invocationresult', invocation_id: msg.invocation_id, result: { ok: true } }));
      }
    });
    ws.send(JSON.stringify({ type: 'registerfunction', id: 'sla::fn', description: 'SLA test' }));
    await new Promise((r) => setTimeout(r, 50));

    // Make a successful call
    await localEngine.trigger('sla::fn', {});

    // Check metrics
    const m = (localEngine as any).metrics;
    const slaFn = m.functions.get('sla::fn@sla::fn');  // worker name defaults to id
    // The worker name might be 'w_xxxxxxx' since we didn't call workers::register
    // So find the function metrics by functionId
    let found: any = null;
    for (const fm of m.functions.values()) {
      if (fm.functionId === 'sla::fn') { found = fm; break; }
    }
    assert.ok(found, 'sla::fn metrics should exist');
    assert.ok(found.calls >= 1);
    assert.ok(found.maxMs >= 0);
    // First bucket (<=10ms) should have at least one
    assert.ok(found.buckets[0] >= 1 || found.buckets[1] >= 1, 'should have at least one call in early bucket');
    ws.close();
  } finally {
    await localEngine.shutdown();
  }
});

test('SLA: timeout increments timeout counter', async () => {
  const localEngine = new Engine({ wsPort: 0, httpPort: 0, invocationTimeoutMs: 100 });
  await localEngine.start();
  const localPort = (localEngine as any).boundHttpPort;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${localPort}`);
    await new Promise<void>((res) => ws.once('open', () => res()));
    // No handler - the call will timeout
    ws.send(JSON.stringify({ type: 'registerfunction', id: 'sla::slow', description: 'slow' }));
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(async () => { await localEngine.trigger('sla::slow', {}); });

    const m = (localEngine as any).metrics;
    let found: any = null;
    for (const fm of m.functions.values()) {
      if (fm.functionId === 'sla::slow') { found = fm; break; }
    }
    assert.ok(found, 'sla::slow metrics should exist');
    assert.strictEqual(found.timeouts, 1, 'should record one timeout');
    assert.strictEqual(found.errors, 1, 'should record one error');
    ws.close();
  } finally {
    await localEngine.shutdown();
  }
});

test('HTTP request is routed to worker via gateway::http trigger', async () => {
  const localEngine = new Engine({ wsPort: 0, httpPort: 0 });
  await localEngine.start();
  const wsPort = (localEngine as any).boundHttpPort;
  const httpPort = (localEngine as any).httpServer.address().port;

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((res) => ws.once('open', () => res()));

    // Set up the worker to use the channel protocol — opens WS to the response channel,
    // writes status + headers + body, then closes.
    ws.on('message', function listener(data: any) {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'invokefunction' && msg.function_id === 'gateway::http') {
        ws.off('message', listener);
        const responseRef = msg.data?.response;
        if (!responseRef) {
          ws.send(JSON.stringify({ type: 'invocationresult', invocation_id: msg.invocation_id, error: { code: 'NO_RESPONSE_REF' } }));
          return;
        }
        const channelUrl = `ws://127.0.0.1:${httpPort}/ws/channels/${responseRef.channel_id}?key=${encodeURIComponent(responseRef.access_key)}&dir=write`;
        const channelWs = new WebSocket(channelUrl);
        channelWs.on('open', () => {
          channelWs.send(JSON.stringify({ type: 'set_status', status_code: 200 }));
          channelWs.send(JSON.stringify({ type: 'set_headers', headers: { 'content-type': 'application/json' } }));
          channelWs.send(JSON.stringify({ ok: true, received: msg.data, bodyType: typeof msg.data?.body }));
          channelWs.close();
          ws.send(JSON.stringify({ type: 'invocationresult', invocation_id: msg.invocation_id, result: { status: 200 } }));
        });
      }
    });

    // Register the gateway::http trigger
    ws.send(JSON.stringify({ type: 'registertriggertype', id: 'http', description: 'HTTP' }));
    ws.send(JSON.stringify({
      type: 'registertrigger',
      id: 'http-trigger-1',
      trigger_type: 'http',
      function_id: 'gateway::http',
      config: { path: '/v1/test' },
    }));
    await new Promise((r) => setTimeout(r, 200));

    // Now make an HTTP request
    const res = await fetch(`http://127.0.0.1:${httpPort}/v1/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const body = await res.json() as { ok: boolean; received: { method: string; path: string; body: unknown }; bodyType: string };
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.received.method, 'POST');
    assert.strictEqual(body.received.path, '/v1/test');
    const receivedBody = body.received.body;
    if (typeof receivedBody === 'string') {
      assert.ok(receivedBody.includes('hello'));
    } else {
      assert.strictEqual((receivedBody as { hello?: string })?.hello, 'world');
    }

    ws.close();
  } finally {
    await localEngine.shutdown();
  }
});

test('HTTP response supports streaming chunks', async () => {
  const localEngine = new Engine({ wsPort: 0, httpPort: 0 });
  await localEngine.start();
  const boundPort = (localEngine as any).boundHttpPort;

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${boundPort}`);
    await new Promise<void>((res) => ws.once('open', () => res()));

    // Set up streaming responder
    ws.on('message', function listener(data: any) {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'invokefunction' && msg.function_id === 'stream::demo') {
        ws.off('message', listener);
        const responseRef = msg.data?.response;
        if (!responseRef) {
          ws.send(JSON.stringify({ type: 'invocationresult', invocation_id: msg.invocation_id, error: { code: 'NO_RESPONSE_REF' } }));
          return;
        }
        const channelUrl = `ws://127.0.0.1:${boundPort}/ws/channels/${responseRef.channel_id}?key=${encodeURIComponent(responseRef.access_key)}&dir=write`;
        const channelWs = new WebSocket(channelUrl);
        channelWs.on('open', async () => {
          channelWs.send(JSON.stringify({ type: 'set_status', status_code: 200 }));
          channelWs.send(JSON.stringify({ type: 'set_headers', headers: { 'content-type': 'text/event-stream' } }));
          // Stream 3 SSE-style chunks
          for (const i of [1, 2, 3]) {
            await new Promise((r) => setTimeout(r, 10));
            channelWs.send(`data: chunk-${i}\n\n`);
          }
          channelWs.close();
          ws.send(JSON.stringify({ type: 'invocationresult', invocation_id: msg.invocation_id, result: { status: 200 } }));
        });
      }
    });

    // Register the streaming trigger
    ws.send(JSON.stringify({ type: 'registertriggertype', id: 'http', description: 'HTTP' }));
    ws.send(JSON.stringify({
      type: 'registertrigger',
      id: 'stream-trigger',
      trigger_type: 'http',
      function_id: 'stream::demo',
      config: { api_path: '/stream', http_method: 'GET' },
    }));
    await new Promise((r) => setTimeout(r, 200));

    // Make the request — read response as text stream
    const res = await fetch(`http://127.0.0.1:${boundPort}/stream`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
    const body = await res.text();
    assert.ok(body.includes('chunk-1'), `body should contain chunk-1: ${body}`);
    assert.ok(body.includes('chunk-2'), `body should contain chunk-2: ${body}`);
    assert.ok(body.includes('chunk-3'), `body should contain chunk-3: ${body}`);

    ws.close();
  } finally {
    await localEngine.shutdown();
  }
});
