/**

The III Engine - WebSocket IPC hub for routing function calls between workers.

Workers connect via registerWorker() from iii-sdk. Each worker registers functions
by ID (e.g. "translator::resolve"). Callers use trigger({ function_id, payload })
to invoke them. The engine handles correlation, routing, and channel bridging.
*/
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import type { Readable, Writable } from 'stream';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InvocationResult = { ok: true; value: unknown } | { ok: false; error: unknown };

interface WorkerInfo {
  id: string;
  name: string;
  ws: WebSocket;
  runtime?: string;
  version?: string;
  os?: string;
  pid?: number;
  /** functionId → registered handler (null = remote/http handler) */
  functions: Map<string, { description?: string; metadata?: Record<string, unknown> }>;
  triggerTypes: Set<string>;
  /** triggerId → { type, functionId, config, metadata } */
  triggers: Map<string, { type: string; functionId: string; config: unknown; metadata?: Record<string, unknown> }>;
  /** channels created by this worker */
  channels: Set<string>;
}

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface EngineOptions {
  /** WebSocket port (default 49134) */
  wsPort?: number;
  /** HTTP port for client requests (default 3000) */
  httpPort?: number;
  /** Default invocation timeout in ms (default 30000) */
  invocationTimeoutMs?: number;
  /** Logger function (default structured JSON to stdout) */
  log?: (obj: Record<string, unknown>) => void;
}

interface LogFields {
  msg: string;
  [key: string]: unknown;
}

export class Engine {
  private readonly wsPort: number;
  private readonly httpPort: number;
  private readonly timeout: number;
  private readonly log: (obj: LogFields) => void;

  private wsServer: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;

  /** workerId → WorkerInfo */
  private readonly workers = new Map<string, WorkerInfo>();
  /** correlationId → pending call */
  private readonly pending = new Map<string, PendingCall>();
  /** channelId → { readWs, writeWs, readerCount, writerCount } */
  private readonly channels = new Map<string, ChannelBridge>();

  private httpTriggerWorker: WorkerInfo | null = null;
  private shuttingDown = false;
  private connections: Set<WebSocket> = new Set();

  constructor(opts: EngineOptions = {}) {
    this.wsPort = opts.wsPort ?? 49134;
    this.httpPort = opts.httpPort ?? 3000;
    this.timeout = opts.invocationTimeoutMs ?? 30_000;
    this.log = opts.log ?? ((obj) => process.stdout.write(JSON.stringify({ ts: Date.now(), ...obj }) + '\n'));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.wsServer = new WebSocketServer({ port: this.wsPort, noServer: false });
    this.httpServer = createServer(this.httpHandler.bind(this));

    this.wsServer.on('connection', this.onWsConnection.bind(this));
    this.wsServer.on('error', (err) => this.log({ msg: 'ws-error', err: String(err) }));

    await new Promise<void>((res) => {
      this.httpServer!.listen(this.httpPort, () => {
        this.log({ msg: 'engine.http.listening', port: this.httpPort });
        res();
      });
    });

    this.log({ msg: 'engine.started', wsPort: this.wsPort, httpPort: this.httpPort, pid: process.pid });

    // SIGTERM / SIGINT → graceful shutdown
    const shutdown = () => { if (!this.shuttingDown) this.shutdown().then(() => process.exit(0)); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.log({ msg: 'engine.shutdown', phase: 'start' });

    // Stop accepting new connections
    this.wsServer?.close();
    this.httpServer?.close();

    // Wait briefly for in-flight calls
    const pending = this.pending.size;
    if (pending > 0) {
      this.log({ msg: 'engine.waiting-for-inflight', count: pending });
      await wait(Math.min(this.timeout, 5000));
    }

    // Close all worker connections
    for (const [, worker] of this.workers) {
      try { worker.ws.close(1001, 'engine-shutdown'); } catch {}
    }
    this.workers.clear();

    // Close channel bridges
    for (const ch of this.channels.values()) {
      try { ch.readable.destroy(); } catch {}
      try { ch.writable.destroy(); } catch {}
    }
    this.channels.clear();

    this.log({ msg: 'engine.shutdown', phase: 'done' });
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection handler
  // ---------------------------------------------------------------------------

  private onWsConnection(ws: WebSocket, _req: IncomingMessage): void {
    this.connections.add(ws);

    // Auto-register worker on connect with a temp ID; name is updated on workers::register
    const workerId = `w_${crypto.randomUUID().slice(0, 8)}`;
    const worker: WorkerInfo = {
      id: workerId,
      name: workerId,
      ws,
      functions: new Map(),
      triggerTypes: new Set(),
      triggers: new Map(),
      channels: new Set(),
    };
    this.workers.set(workerId, worker);
    this.log({ msg: 'worker.connected', workerId });

    const send = (msg: Record<string, unknown>): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      const messageType = msg.type as string;

      switch (messageType) {
        case 'registerfunction':
          this.handleRegisterFunction(workerId, msg as any);
          break;
        case 'unregisterfunction':
          this.handleUnregisterFunction(workerId, msg as any);
          break;
        case 'registertriggertype':
          this.handleRegisterTriggerType(workerId, msg as any);
          break;
        case 'registertrigger':
          this.handleRegisterTrigger(workerId, msg as any);
          break;
        case 'unregistertrigger':
          this.handleUnregisterTrigger(workerId, msg as any);
          break;
        case 'invocationresult':
          this.handleInvocationResult(msg as any);
          break;
        case 'invokefunction':
          // Worker is calling a function (typically engine::workers::register)
          this.handleWorkerInvokeFunction(workerId, msg as any, send);
          break;
        case 'channelbridge':
          this.handleChannelBridge(ws, msg as any);
          break;
        default:
          this.log({ msg: 'unknown-message-type', from: workerId, type: messageType });
      }
    });

    ws.on('close', () => {
      this.connections.delete(ws);
      const w = this.workers.get(workerId);
      if (w) {
        this.log({ msg: 'worker.disconnected', workerId: w.id, workerName: w.name });
        this.workers.delete(workerId);
        if (this.httpTriggerWorker?.id === workerId) this.httpTriggerWorker = null;
      }
    });

    ws.on('error', (err) => this.log({ msg: 'ws-client-error', workerId, err: String(err) }));
  }

  private handleWorkerInvokeFunction(workerId: string, msg: { invocation_id?: string; function_id: string; data?: unknown; action?: unknown }, send: (m: Record<string, unknown>) => void): void {
    const { invocation_id, function_id, data } = msg;
    const fnId = function_id as string;

    // Built-in engine functions
    if (fnId === 'engine::workers::register') {
      const payload = (data as any) ?? {};
      const name = (payload.name as string) ?? workerId;
      const worker = this.workers.get(workerId);
      if (worker) {
        worker.name = name;
        worker.runtime = payload.runtime;
        worker.version = payload.version;
        worker.os = payload.os;
        worker.pid = payload.pid;
      }
      this.log({ msg: 'worker.registered', workerId, name, runtime: payload.runtime });
      // Respond with workerregistered
      if (invocation_id) {
        send({ type: 'invocationresult', invocation_id, result: { worker_id: workerId, worker_name: name } });
      }
      return;
    }
    if (fnId === 'engine::functions::list') {
      const fns: Array<{ id: string; description?: string; worker: string }> = [];
      for (const worker of this.workers.values()) {
        for (const [id, info] of worker.functions) {
          fns.push({ id, description: info.description, worker: worker.name });
        }
      }
      if (invocation_id) send({ type: 'invocationresult', invocation_id, result: fns });
      return;
    }
    if (fnId === 'engine::workers::list') {
      const list = [...this.workers.values()].map((w) => ({ worker_id: w.id, worker_name: w.name, runtime: w.runtime, status: 'online' }));
      if (invocation_id) send({ type: 'invocationresult', invocation_id, result: list });
      return;
    }
    if (fnId === 'engine::triggers::list') {
      const types: string[] = [];
      for (const w of this.workers.values()) for (const t of w.triggerTypes) types.push(t);
      if (invocation_id) send({ type: 'invocationresult', invocation_id, result: types });
      return;
    }
    if (fnId === 'engine::registered-triggers::list') {
      const list: Array<{ id: string; type: string; function_id: string; worker: string }> = [];
      for (const w of this.workers.values()) {
        for (const [id, trig] of w.triggers) list.push({ id, type: trig.type, function_id: trig.functionId, worker: w.name });
      }
      if (invocation_id) send({ type: 'invocationresult', invocation_id, result: list });
      return;
    }
    // Unknown engine function — fail with error
    if (fnId.startsWith('engine::') && invocation_id) {
      send({ type: 'invocationresult', invocation_id, error: { code: 'NOT_FOUND', message: `unknown engine function: ${fnId}` } });
      return;
    }
    // Otherwise, this is a worker calling a non-engine function — should be sent via public API, not direct ws
    if (invocation_id) {
      send({ type: 'invocationresult', invocation_id, error: { code: 'BAD_REQUEST', message: 'workers cannot call non-engine functions directly' } });
    }
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  private handleRegisterFunction(workerId: string, msg: {
    id: string; description?: string;
    request_format?: unknown; response_format?: unknown; metadata?: Record<string, unknown>;
  }): void {
    if (!workerId) return;
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.functions.set(msg.id, { description: msg.description, metadata: msg.metadata });
    this.log({ msg: 'function.registered', functionId: msg.id, workerId, description: msg.description });
  }

  private handleUnregisterFunction(workerId: string, msg: { id: string }): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.functions.delete(msg.id);
      this.log({ msg: 'function.unregistered', functionId: msg.id, workerId });
    }
  }

  private handleRegisterTriggerType(workerId: string, msg: { id: string; description?: string }): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.triggerTypes.add(msg.id);
    this.log({ msg: 'trigger-type.registered', triggerTypeId: msg.id, workerId });

    // Remember the http trigger worker
    if (msg.id === 'http') {
      this.httpTriggerWorker = worker;
      this.log({ msg: 'http-trigger.assigned', workerId });
    }
  }

  private handleRegisterTrigger(workerId: string, msg: {
    id: string; trigger_type?: string; type?: string; function_id: string; config?: unknown; metadata?: Record<string, unknown>;
  }): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    const triggerType = msg.trigger_type ?? msg.type ?? '';
    worker.triggers.set(msg.id, { type: triggerType, functionId: msg.function_id, config: msg.config, metadata: msg.metadata });
    this.log({ msg: 'trigger.registered', triggerId: msg.id, type: msg.type, functionId: msg.function_id, workerId });
  }

  private handleUnregisterTrigger(workerId: string, msg: { id: string }): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.triggers.delete(msg.id);
      this.log({ msg: 'trigger.unregistered', triggerId: msg.id, workerId });
    }
  }

  private handleInvocationResult(msg: { invocation_id?: string; result?: unknown; error?: unknown }): void {
    const id = msg.invocation_id as string;
    const pending = this.pending.get(id);
    if (!pending) {
      this.log({ msg: 'unexpected-invocation-result', id });
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (msg.error !== undefined) {
      pending.reject(msg.error);
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleChannelBridge(ws: WebSocket, msg: {
    channel_id: string; access_key?: string; direction: 'connect' | 'create';
    channel_side: 'read' | 'write'; port?: number;
  }): void {
    // Channel bridging: connect two WebSocket halves
    const { channel_id, direction, channel_side } = msg;
    if (direction === 'connect') {
      // Worker is connecting to an existing channel
      const bridge = this.channels.get(channel_id);
      if (!bridge) {
        this.log({ msg: 'channel.not-found', channelId: channel_id });
        return;
      }
      if (channel_side === 'write') {
        bridge.writeWs = ws;
        bridge.writerCount++;
      } else {
        bridge.readWs = ws;
        bridge.readerCount++;
      }
      this.pipeChannel(bridge);
    } else {
      // Worker is creating a channel
      if (channel_side === 'write') {
        const bridge: ChannelBridge = { channelId: channel_id, readable: null!, writable: null!, writeWs: ws, readWs: null, readerCount: 0, writerCount: 1 };
        this.channels.set(channel_id, bridge);
      }
    }
  }

  private pipeChannel(bridge: ChannelBridge): void {
    if (!bridge.readable || !bridge.writable) return;
    bridge.readable.pipe(bridge.writable);
  }

  // ---------------------------------------------------------------------------
  // Public trigger API (used by HTTP handler and tests)
  // ---------------------------------------------------------------------------

  async trigger<T = unknown>(functionId: string, payload?: unknown): Promise<T> {
    if (this.shuttingDown) throw new Error('engine-shutting-down');

    // Built-in engine functions
    if (functionId === 'engine::functions::list') {
      const fns: Array<{ id: string; description?: string; worker: string }> = [];
      for (const worker of this.workers.values()) {
        for (const [id, info] of worker.functions) {
          fns.push({ id, description: info.description, worker: worker.name });
        }
      }
      return fns as unknown as T;
    }
    if (functionId === 'engine::workers::list') {
      return [...this.workers.values()].map((w) => ({ worker_id: w.id, worker_name: w.name, runtime: w.runtime, status: 'online' })) as unknown as T;
    }

    // Route to registered function
    const targetWorker = this.findFunctionOwner(functionId);
    if (!targetWorker) throw new Error(`function-not-found:${functionId}`);

    return this.sendInvocation<T>(targetWorker, functionId, payload);
  }

  private findFunctionOwner(functionId: string): WorkerInfo | undefined {
    for (const worker of this.workers.values()) {
      if (worker.functions.has(functionId)) return worker;
    }
    return undefined;
  }

  private sendInvocation<T>(worker: WorkerInfo, functionId: string, payload: unknown): Promise<T> {
    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`invocation-timeout:${functionId}`));
        }
      }, this.timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout });
      const msg = { type: 'invokefunction', invocation_id: id, function_id: functionId, data: payload };
      if (worker.ws.readyState === WebSocket.OPEN) {
        worker.ws.send(JSON.stringify(msg));
      } else {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`worker-not-connected:${worker.id}`));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP handler (for client requests routed via gateway::http trigger)
  // ---------------------------------------------------------------------------

  private httpHandler(req: IncomingMessage, res: ServerResponse): void {
    if (this.shuttingDown) { res.writeHead(503); res.end(); return; }
    const url = req.url ?? '/';
    // Health endpoints (no routing required)
    if (url === '/health' || url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ts: Date.now(), pid: process.pid }));
      return;
    }
    if (url === '/ready' || url === '/readyz') {
      const ready = this.httpTriggerWorker !== null;
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready, workers: this.workers.size, has_http_worker: ready }));
      return;
    }
    if (url === '/metrics') {
      const metrics = {
        workers: this.workers.size,
        functions: [...this.workers.values()].reduce((n, w) => n + w.functions.size, 0),
        triggers: [...this.workers.values()].reduce((n, w) => n + w.triggers.size, 0),
        in_flight: this.pending.size,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(metrics));
      return;
    }
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      res.end();
      return;
    }

    const worker = this.httpTriggerWorker;
    if (!worker) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no-http-trigger-worker' }));
      return;
    }

    // Parse body
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = {
          path: req.url ?? '/',
          method: req.method,
          headers: req.headers,
          body: body || undefined,
        };
        const result = await this.sendInvocation(worker, 'gateway::http', payload) as { status?: number; headers?: Record<string, string>; body?: string };
        res.writeHead(result.status ?? 200, {
          'content-type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          ...result.headers,
        });
        res.end(result.body ?? '');
      } catch (err: any) {
        this.log({ msg: 'http.invoke-error', err: String(err) });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message ?? 'internal-error' }));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ChannelBridge {
  channelId: string;
  readable: Readable;
  writable: Writable;
  writeWs: WebSocket | null;
  readWs: WebSocket | null;
  readerCount: number;
  writerCount: number;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

// Detect direct execution: in ESM, import.meta.url is the file path
// and process.argv[1] is the entry script
const isMain = (() => {
  try {
    const arg1 = process.argv[1];
    if (!arg1) return false;
    return import.meta.url === new URL('file://' + arg1).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const engine = new Engine({ wsPort: 49134, httpPort: 3000 });
  engine.start().catch((err) => {
    console.error('engine-start-error', err);
    process.exit(1);
  });
}

export default Engine;
