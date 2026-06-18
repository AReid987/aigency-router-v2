import { test } from 'node:test';
import { Engine } from './engine.js';
import { registerWorker } from 'iii-sdk';

test('real iii-sdk worker can register against iii-engine', async () => {
  const engine = new Engine({ wsPort: 0, httpPort: 0 });
  await engine.start();
  const port = (engine as any).boundHttpPort;

  try {
    const iii = registerWorker(`ws://127.0.0.1:${port}`, { workerName: 'test-worker' });
    iii.registerFunction('sdk::greet', async (name: unknown) => {
      return { greeting: `hello, ${name}` };
    });

    await new Promise((r) => setTimeout(r, 500));

    const workers = await engine.trigger<any[]>('engine::workers::list');
    if (!Array.isArray(workers)) throw new Error('workers not array: ' + typeof workers);
    const sdkWorker = workers.find((w: any) => w.worker_name === 'test-worker');
    if (!sdkWorker) throw new Error('test-worker missing. Got: ' + JSON.stringify(workers));
    if (sdkWorker.runtime !== 'node') throw new Error('runtime not node: ' + sdkWorker.runtime);

    const fns = await engine.trigger<any[]>('engine::functions::list');
    const greet = fns.find((f: any) => f.id === 'sdk::greet');
    if (!greet) throw new Error('sdk::greet missing. Got: ' + JSON.stringify(fns));
    if (greet.worker !== 'test-worker') throw new Error('worker not test-worker: ' + greet.worker);

    // Test invocation flow: caller triggers, SDK worker returns result
    const result = await engine.trigger<any>('sdk::greet', 'world');
    if (result?.greeting !== 'hello, world') throw new Error('bad greeting result: ' + JSON.stringify(result));

    await iii.shutdown();
  } finally {
    await engine.shutdown();
  }
});
