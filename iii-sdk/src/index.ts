/**
 * iii-sdk TypeScript declarations (LOCAL VERSION).
 *
 * This package re-declares the public API of iii-sdk@0.17.0 (the npm package)
 * for use by iii-engine's reference implementations and tests. The real
 * implementation lives in node_modules/iii-sdk/. This file provides the
 * type-only contract that AIGENCY workers depend on.
 *
 * For the actual implementation, see:
 *   node_modules/iii-sdk/dist/index.mjs
 *   node_modules/iii-sdk/dist/index.d.mts
 */

// ── Message Types ──────────────────────────────────────────────────────

export const MessageType = {
  RegisterFunction: 'registerfunction',
  UnregisterFunction: 'unregisterfunction',
  InvokeFunction: 'invokefunction',
  InvocationResult: 'invocationresult',
  RegisterTriggerType: 'registertriggertype',
  RegisterTrigger: 'registertrigger',
  UnregisterTrigger: 'unregistertrigger',
  UnregisterTriggerType: 'unregistertriggertype',
  TriggerRegistrationResult: 'triggerregistrationresult',
  WorkerRegistered: 'workerregistered',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const EngineFunctions = {
  LIST_FUNCTIONS: 'engine::functions::list',
  INFO_FUNCTIONS: 'engine::functions::info',
  LIST_WORKERS: 'engine::workers::list',
  INFO_WORKERS: 'engine::workers::info',
  LIST_TRIGGERS: 'engine::triggers::list',
  INFO_TRIGGERS: 'engine::triggers::info',
  LIST_REGISTERED_TRIGGERS: 'engine::registered-triggers::list',
  INFO_REGISTERED_TRIGGERS: 'engine::registered-triggers::info',
  REGISTER_WORKER: 'engine::workers::register',
} as const;

export const EngineTriggers = {
  FUNCTIONS_AVAILABLE: 'engine::functions-available',
  LOG: 'log',
} as const;

// ── HTTP Types ─────────────────────────────────────────────────────────

export interface HttpRequest<TBody = unknown> {
  path_params: Record<string, string>;
  query_params: Record<string, string | string[]>;
  body: TBody;
  headers: Record<string, string | string[]>;
  method: string;
  request_body: ChannelReader;
}

export interface HttpResponse {
  status(statusCode: number): void;
  headers(headers: Record<string, string>): void;
  stream: NodeJS.WritableStream;
  close(): void;
}

export type ApiResponse = unknown;

// ── Channels ──────────────────────────────────────────────────────────

export interface StreamChannelRef {
  channel_id: string;
  access_key: string;
  direction: 'read' | 'write';
}

export interface Channel {
  writerRef: StreamChannelRef;
  readerRef: StreamChannelRef;
  writer: ChannelWriter;
  reader: ChannelReader;
}

export interface ChannelWriter {
  stream: NodeJS.WritableStream;
  sendMessage(msg: string): void;
  close(): void;
}

export interface ChannelReader {
  onMessage(callback: (msg: string) => void): void;
  on(event: 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  close(): void;
}

// ── Function Registration ──────────────────────────────────────────────

export type RemoteFunctionHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
) => Promise<TOutput> | TOutput;

export interface RegisterFunctionInput<TInput = unknown, TOutput = unknown> {
  id?: string;
  description?: string;
  request_format?: unknown;
  response_format?: unknown;
  metadata?: Record<string, unknown>;
  handler: RemoteFunctionHandler<TInput, TOutput>;
}

// ── Trigger Types ──────────────────────────────────────────────────────

export interface TriggerTypeHandler<TConfig = unknown> {
  register?(triggerId: string, config: TConfig, metadata?: Record<string, unknown>): Promise<void> | void;
  unregister?(triggerId: string): Promise<void> | void;
}

export interface RegisterTriggerTypeInput<TConfig = unknown> {
  id: string;
  description?: string;
  handler: TriggerTypeHandler<TConfig>;
}

export interface TriggerTypeRef<TConfig = unknown> {
  id: string;
  registerTrigger(
    function_id: string,
    config: TConfig,
    metadata?: Record<string, unknown>,
  ): { unregister(): Promise<void> };
}

export interface Trigger {
  type: string;
  function_id: string;
  config?: unknown;
  metadata?: Record<string, unknown>;
  id?: string;
}

// ── Trigger ────────────────────────────────────────────────────────────

export interface TriggerAction {
  type: 'queue' | 'http-response' | 'void' | string;
  [key: string]: unknown;
}

export interface TriggerRequest<TInput = unknown> {
  function_id: string;
  payload?: TInput;
  action?: TriggerAction;
  timeoutMs?: number;
}

// ── Error ──────────────────────────────────────────────────────────────

export interface IIIInvocationErrorInit {
  code: string;
  message: string;
  function_id?: string;
  cause?: unknown;
}

export class IIIInvocationError extends Error {
  code: string;
  function_id?: string;
  cause?: unknown;
  constructor(init: IIIInvocationErrorInit) {
    super(init.message);
    this.name = 'IIIInvocationError';
    this.code = init.code;
    this.function_id = init.function_id;
    this.cause = init.cause;
  }
}

// ── SDK Interface ──────────────────────────────────────────────────────

export interface InitOptions {
  workerName?: string;
  headers?: Record<string, string>;
  /** Reconnection config (defaults are sensible) */
  reconnection?: {
    maxRetries?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
    maxDelayMs?: number;
    jitterFactor?: number;
  };
  /** Per-invocation timeout in ms (default 30000) */
  invocationTimeoutMs?: number;
  /** Telemetry opt-in */
  telemetry?: {
    language?: string;
    project_name?: string;
    framework?: string;
    amplitude_api_key?: string;
  };
}

export interface ISdk {
  readonly workerId: string;

  registerFunction<TInput = unknown, TOutput = unknown>(
    fnId: string,
    handler: RemoteFunctionHandler<TInput, TOutput>,
  ): void;
  unregisterFunction(functionId: string): void;

  registerTriggerType<TConfig = unknown>(
    triggerType: { id: string; description?: string },
    handler: TriggerTypeHandler<TConfig>,
  ): TriggerTypeRef<TConfig>;
  unregisterTriggerType(triggerType: { id: string }): void;

  registerTrigger(trigger: Trigger): { unregister(): Promise<void> };
  unregisterTrigger(trigger: { id: string }): void;

  trigger<TOutput = unknown>(request: TriggerRequest): Promise<TOutput>;
  trigger(request: TriggerRequest & { action: { type: 'void' } }): Promise<void>;

  createChannel(bufferSize?: number): Promise<Channel>;

  shutdown(): Promise<void>;
}

// ── HTTP Wrapper ───────────────────────────────────────────────────────

export type HttpHandler = (
  callback: (req: HttpRequest, res: HttpResponse) => Promise<ApiResponse | void>,
) => (req: HttpRequest & { response: ChannelWriter }) => Promise<ApiResponse>;

export const http: HttpHandler = (() => {
  throw new Error('iii-sdk local stub: use the real iii-sdk from node_modules.');
}) as HttpHandler;

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Local stub: throws at runtime. Workers must use the real iii-sdk from
 * node_modules. This file provides type declarations only.
 */
export const registerWorker: (address: string, options?: InitOptions | string) => ISdk = (() => {
  const fn = (): never => {
    throw new Error(
      'iii-sdk local stub: use the real iii-sdk from node_modules (npm package) in production. ' +
      'This file provides type declarations only.',
    );
  };
  return fn as unknown as ISdk extends never ? never : (address: string, options?: InitOptions | string) => ISdk;
})();

// ── Logger Stub ────────────────────────────────────────────────────────

export const Logger = {
  debug: (msg: string) => console.debug(msg),
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};
