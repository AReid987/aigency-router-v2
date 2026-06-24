/**

The III Engine - WebSocket IPC hub for routing function calls between workers.

Workers connect via registerWorker() from iii-sdk. Each worker registers functions
by ID (e.g. "translator::resolve"). Callers use trigger({ function_id, payload })
to invoke them. The engine handles correlation, routing, and channel bridging.
*/
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';


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

interface FunctionMetrics {
  functionId: string;
  workerName: string;
  calls: number;
  errors: number;
  timeouts: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  /** Latency histogram bucket counts: [<=10ms, <=50, <=100, <=500, <=1000, <=5000, <=30000, +Inf] */
  buckets: number[];
  /** Last call timestamp (ms since epoch) */
  lastCallAt: number;
}

interface EngineMetrics {
  startedAt: number;
  totalCalls: number;
  totalErrors: number;
  totalTimeouts: number;
  functions: Map<string, FunctionMetrics>;
}

export class Engine {
  private readonly wsPort: number;
  private readonly httpPort: number;
  private readonly timeout: number;
  private readonly log: (obj: LogFields) => void;

  private wsServer: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private boundHttpPort: number = 0;

  /** workerId → WorkerInfo */
  private readonly workers = new Map<string, WorkerInfo>();
  /** correlationId → pending call */
  private readonly pending = new Map<string, PendingCall>();
  /** channelId → { readWs, writeWs, readerCount, writerCount } */
  private readonly channels = new Map<string, ChannelState>();

  private httpTriggerWorker: WorkerInfo | null = null;

  /** The actual bound port (after start()). Both worker WS and HTTP API listen here. */
  public get port(): number {
    return this.boundHttpPort;
  }
  private shuttingDown = false;
  private connections: Set<WebSocket> = new Set();
  private readonly metrics: EngineMetrics = {
    startedAt: Date.now(),
    totalCalls: 0,
    totalErrors: 0,
    totalTimeouts: 0,
    functions: new Map(),
  };

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
    // Use a single shared HTTP server. The worker WebSocketServer is in noServer mode
    // so we can route upgrades through the HTTP server's upgrade event.
    this.httpServer = createServer();
    this.wsServer = new WebSocketServer({ noServer: true });
    this.httpServer.on('request', this.httpHandler.bind(this));
    this.httpServer.on('upgrade', this.handleUpgrade.bind(this));

    this.wsServer.on('connection', this.onWsConnection.bind(this));
    this.wsServer.on('error', (err) => this.log({ msg: 'ws-error', err: String(err) }));

    await new Promise<void>((res) => {
      this.httpServer!.listen(this.httpPort, () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') this.boundHttpPort = addr.port;
        this.log({ msg: 'engine.listening', port: this.boundHttpPort });
        res();
      });
    });

    this.log({ msg: 'engine.started', wsPort: this.httpPort, httpPort: this.httpPort, pid: process.pid });

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

    // Close channel WebSocket connections
    for (const ch of this.channels.values()) {
      try { ch.writeWs?.close(1001, 'engine-shutdown'); } catch {}
      for (const ws of ch.readWss) {
        try { ws.close(1001, 'engine-shutdown'); } catch {}
      }
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
    if (fnId === 'engine::channels::create') {
      const writer = this.createChannel();
      const result = {
        writer: { channel_id: writer.channelId, access_key: writer.writerKey, direction: 'write' as const },
        reader: { channel_id: writer.channelId, access_key: writer.readerKey, direction: 'read' as const },
      };
      if (invocation_id) send({ type: 'invocationresult', invocation_id, result });
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
      this.log({ msg: 'http-trigger.assigned', workerId, via: 'registertriggertype' });
    }
  }

  private handleRegisterTrigger(workerId: string, msg: {
    id: string; trigger_type?: string; type?: string; function_id: string; config?: unknown; metadata?: Record<string, unknown>;
  }): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    const triggerType = msg.trigger_type ?? msg.type ?? '';
    worker.triggers.set(msg.id, { type: triggerType, functionId: msg.function_id, config: msg.config, metadata: msg.metadata });
    this.log({ msg: 'trigger.registered', triggerId: msg.id, trigger_type: triggerType, functionId: msg.function_id, workerId });
    if (triggerType === 'http' && !this.httpTriggerWorker) {
      this.httpTriggerWorker = worker;
      this.log({ msg: 'http-trigger.assigned', workerId, via: 'registertrigger' });
    }
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

  private recordInvocationStart(functionId: string, workerName: string): number {
    this.metrics.totalCalls++;
    const id = `${functionId}@${workerName}`;
    let m = this.metrics.functions.get(id);
    if (!m) {
      m = {
        functionId, workerName,
        calls: 0, errors: 0, timeouts: 0, totalMs: 0,
        minMs: Infinity, maxMs: 0,
        buckets: [0, 0, 0, 0, 0, 0, 0, 0],
        lastCallAt: 0,
      };
      this.metrics.functions.set(id, m);
    }
    m.lastCallAt = Date.now();
    return Date.now();
  }

  private recordInvocationEnd(functionId: string, workerName: string, startMs: number, ok: boolean, errorKind?: 'error' | 'timeout'): void {
    const id = `${functionId}@${workerName}`;
    const m = this.metrics.functions.get(id);
    if (!m) return;
    const dur = Date.now() - startMs;
    m.calls++;
    m.totalMs += dur;
    if (dur < m.minMs) m.minMs = dur;
    if (dur > m.maxMs) m.maxMs = dur;
    // Bucket counts: <=10, <=50, <=100, <=500, <=1000, <=5000, <=30000, +Inf
    if (dur <= 10) m.buckets[0]!++;
    else if (dur <= 50) m.buckets[1]!++;
    else if (dur <= 100) m.buckets[2]!++;
    else if (dur <= 500) m.buckets[3]!++;
    else if (dur <= 1000) m.buckets[4]!++;
    else if (dur <= 5000) m.buckets[5]!++;
    else if (dur <= 30000) m.buckets[6]!++;
    else m.buckets[7]!++;
    if (!ok) {
      m.errors++;
      this.metrics.totalErrors++;
      if (errorKind === 'timeout') {
        m.timeouts++;
        this.metrics.totalTimeouts++;
      }
    }
  }

  private sendInvocation<T>(worker: WorkerInfo, functionId: string, payload: unknown): Promise<T> {
    const id = crypto.randomUUID();

    const startMs = this.recordInvocationStart(functionId, worker.name);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.recordInvocationEnd(functionId, worker.name, startMs, false, 'timeout');
          reject(new Error(`invocation-timeout:${functionId}`));
        }
      }, this.timeout);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          this.recordInvocationEnd(functionId, worker.name, startMs, true);
          resolve(v as T);
        },
        reject: (e: unknown) => {
          this.recordInvocationEnd(functionId, worker.name, startMs, false, 'error');
          reject(e);
        },
        timeout,
      });
      const msg = { type: 'invokefunction', invocation_id: id, function_id: functionId, data: payload };
      if (worker.ws.readyState === WebSocket.OPEN) {
        worker.ws.send(JSON.stringify(msg));
      } else {
        clearTimeout(timeout);
        this.pending.delete(id);
        this.recordInvocationEnd(functionId, worker.name, startMs, false, 'error');
        reject(new Error(`worker-not-connected:${worker.id}`));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Channels — for streaming responses (used by SDK's http() wrapper)

  private createChannel(): ChannelState {
    const channelId = `ch_${crypto.randomUUID().slice(0, 8)}`;
    const writerKey = `wk_${crypto.randomUUID().slice(0, 12)}`;
    const readerKey = `rk_${crypto.randomUUID().slice(0, 12)}`;
    const state: ChannelState = {
      channelId,
      writerKey,
      readerKey,
      writeWs: null,
      readWss: new Set(),
      createdAt: Date.now(),
    };
    this.channels.set(channelId, state);
    this.log({ msg: 'channel.created', channelId });
    return state;
  }

  /** Validate a channel connection and return the channel + role */
  private validateChannelConnect(channelId: string, key: string, dir: string): { state: ChannelState; role: 'writer' | 'reader' } | null {
    const state = this.channels.get(channelId);
    if (!state) return null;
    if (dir === 'write' && state.writerKey === key) return { state, role: 'writer' };
    if (dir === 'read' && state.readerKey === key) return { state, role: 'reader' };
    return null;
  }

  private attachChannelWriter(state: ChannelState, ws: WebSocket): void {
    state.writeWs = ws;
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      // Forward writer frames to all readers
      for (const readerWs of state.readWss) {
        if (readerWs.readyState === readerWs.OPEN) {
          readerWs.send(data, { binary: isBinary });
        }
      }
    });
    ws.on('close', () => {
      // Close all readers too (writer closed = stream done)
      for (const readerWs of state.readWss) {
        try { readerWs.close(1000, 'writer-closed'); } catch {}
      }
      this.log({ msg: 'channel.writer-closed', channelId: state.channelId });
    });
  }

  private attachChannelReader(state: ChannelState, ws: WebSocket): void {
    state.readWss.add(ws);
    ws.on('close', () => {
      state.readWss.delete(ws);
      this.log({ msg: 'channel.reader-closed', channelId: state.channelId, remaining: state.readWss.size });
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP handler (for client requests routed via gateway::http trigger)

  private findHttpTriggerFunctionId(): string | null {
    for (const worker of this.workers.values()) {
      for (const trig of worker.triggers.values()) {
        if (trig.type === 'http') return trig.functionId;
      }
    }
    return null;
  }


  // ---------------------------------------------------------------------------
  // HTTP WebSocket upgrade router — routes worker upgrades and channel upgrades

  private handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
    const url = req.url ?? '/';
    if (url.startsWith('/ws/channels/')) {
      this.handleChannelUpgrade(req, socket, head, url);
      return;
    }
    // All other paths (worker /, /ws, /otel, etc.) → main worker WSS
    this.wsServer!.handleUpgrade(req, socket, head, (ws) => {
      this.wsServer!.emit('connection', ws, req);
    });
  }

  private handleChannelUpgrade(req: IncomingMessage, socket: any, head: Buffer, url: string): void {
    const match = url.match(/^\/ws\/channels\/([A-Za-z0-9_\-]+)\?(.+)$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const channelId = match[1];
    const params = new URLSearchParams(match[2]);
    const key = params.get('key') ?? '';
    const dir = params.get('dir') ?? '';

    const validation = this.validateChannelConnect(channelId, key, dir);
    if (!validation) {
      this.log({ msg: 'channel.connect-denied', channelId, dir });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const { state, role } = validation;

    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(req, socket, head, (ws) => {
      this.log({ msg: 'channel.http-connected', channelId: state.channelId, role });
      if (role === 'writer') {
        this.attachChannelWriter(state, ws);
      } else {
        this.attachChannelReader(state, ws);
      }
    });
  }

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
      const functions: Array<Record<string, unknown>> = [];
      for (const m of this.metrics.functions.values()) {
        const avg = m.calls > 0 ? Math.round(m.totalMs / m.calls) : 0;
        functions.push({
          function: m.functionId,
          worker: m.workerName,
          calls: m.calls,
          errors: m.errors,
          timeouts: m.timeouts,
          avg_ms: avg,
          min_ms: m.minMs === Infinity ? 0 : m.minMs,
          max_ms: m.maxMs,
          p50_bucket_le_ms: m.buckets[2]! + m.buckets[3]!,  // <=100ms cumulative
          p95_bucket_le_ms: m.buckets[4]! + m.buckets[5]! + m.buckets[6]!,  // <=5000ms
          slow_calls: m.buckets[7]!,  // > 30s
          last_call_at: m.lastCallAt,
        });
      }
      const metrics = {
        engine: {
          workers: this.workers.size,
          functions_registered: [...this.workers.values()].reduce((n, w) => n + w.functions.size, 0),
          triggers_registered: [...this.workers.values()].reduce((n, w) => n + w.triggers.size, 0),
          in_flight: this.pending.size,
        },
        sla: {
          started_at: this.metrics.startedAt,
          uptime_ms: Date.now() - this.metrics.startedAt,
          total_calls: this.metrics.totalCalls,
          total_errors: this.metrics.totalErrors,
          total_timeouts: this.metrics.totalTimeouts,
          error_rate: this.metrics.totalCalls > 0
            ? Math.round((this.metrics.totalErrors / this.metrics.totalCalls) * 10_000) / 100
            : 0,
        },
        functions,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(metrics, null, 2));
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
        // Parse body as JSON if content-type is JSON, else pass as string
        let parsedBody: unknown = body;
        const contentType = (req.headers['content-type'] as string) ?? '';
        if (body && (contentType.includes('application/json') || body.startsWith('{') || body.startsWith('['))) {
          try { parsedBody = JSON.parse(body); } catch { parsedBody = body; }
        } else if (!body) {
          parsedBody = undefined;
        }
        // Create a channel for the HTTP response (worker writes to it via http() wrapper)
        const channel = this.createChannel();
        const payload = {
          path: req.url ?? '/',
          method: req.method,
          headers: req.headers,
          body: parsedBody,
          path_params: {},
          query_params: this.parseQueryParams(req.url ?? '/'),
          request_body: null,
          response: {
            channel_id: channel.channelId,
            access_key: channel.writerKey,
            direction: 'write' as const,
          },
        };
        // Path-specific routing for OpenAI-compatible endpoints
        const path = req.url ?? '/';
        const pathFnId: Record<string, string> = {
          '/v1/chat/completions': 'gateway::chat_completions',
        };
        const fnId = pathFnId[path] ?? this.findHttpTriggerFunctionId() ?? 'gateway::http';
        this.log({ msg: 'http.route', path, fnId });

        // Connect as a reader to the channel and forward to HTTP response
        const readerWs = new WebSocket(this.buildChannelUrl(channel.channelId, channel.readerKey, 'read'));
        let statusCode = 200;
        const responseHeaders: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
        let headersSet = false;
        let bodyChunks: Buffer[] = [];

        readerWs.on('open', () => {
          // Now invoke the worker — it will open its own WS to the channel as writer
          this.sendInvocation(worker, fnId, payload).catch((err) => {
            this.log({ msg: 'http.invoke-error', err: String(err) });
            if (!headersSet) {
              res.writeHead(500, { 'content-type': 'application/json' });
            }
            res.end(JSON.stringify({ error: err.message ?? 'internal-error' }));
            try { readerWs.close(); } catch {}
          });
        });

        readerWs.on('message', (data: Buffer | string, isBinary: boolean) => {
          if (!isBinary) {
            // Text message: parse JSON, may be control (set_status/set_headers) or body
            try {
              const msg = JSON.parse(data.toString());
              if (msg.type === 'set_status' && typeof msg.status_code === 'number') {
                statusCode = msg.status_code;
                return;
              }
              if (msg.type === 'set_headers' && msg.headers && typeof msg.headers === 'object') {
                Object.assign(responseHeaders, msg.headers);
                return;
              }
              // Not a control message — treat the raw text as body
            } catch { /* not JSON, fall through to body */ }
          }
          // Body chunk (binary OR unhandled text)
          bodyChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });

        readerWs.on('close', () => {
          if (!headersSet) {
            res.writeHead(statusCode, responseHeaders);
            headersSet = true;
          }
          res.end(Buffer.concat(bodyChunks));
        });

        readerWs.on('error', (err) => {
          this.log({ msg: 'channel.reader-error', err: String(err) });
          if (!headersSet) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'channel-error' }));
          } else {
            res.end();
          }
        });
      } catch (err: any) {
        this.log({ msg: 'http.invoke-error', err: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message ?? 'internal-error' }));
        }
      }
    });
  }

  private buildChannelUrl(channelId: string, key: string, dir: 'read' | 'write'): string {
    return `ws://127.0.0.1:${this.boundHttpPort}/ws/channels/${channelId}?key=${encodeURIComponent(key)}&dir=${dir}`;
  }

  private parseQueryParams(url: string): Record<string, string | string[]> {
    const qIdx = url.indexOf('?');
    if (qIdx < 0) return {};
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of params) {
      if (k in out) {
        const existing = out[k];
        out[k] = Array.isArray(existing) ? [...existing, v] : [existing as string, v];
      } else {
        out[k] = v;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ChannelState {
  channelId: string;
  writerKey: string;
  readerKey: string;
  /** WebSocket for the writer (worker side) */
  writeWs: WebSocket | null;
  /** WebSocket(s) for the readers (engine-side HTTP response, or other workers) */
  readWss: Set<WebSocket>;
  createdAt: number;
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
