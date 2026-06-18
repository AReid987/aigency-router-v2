/**
 * Type tests — verifies the iii-sdk public API surface.
 * Not a runtime test — TypeScript checks these at compile time.
 */
import type { ISdk, InitOptions, HttpRequest, HttpResponse, Trigger, StreamChannelRef } from './index.js';
import { EngineFunctions, MessageType, IIIInvocationError, ChannelWriter, ChannelReader } from './index.js';

// These are compile-only assertions; if any of these fail, tsc errors out.

// Type-level checks
const _checks: [
  // EngineFunctions exists
  typeof EngineFunctions.REGISTER_WORKER,
  // MessageType enum members
  typeof MessageType.RegisterFunction,
  // ChannelWriter is an interface
  ChannelWriter,
  // ChannelReader is an interface
  ChannelReader,
] = [
  'engine::workers::register',
  'registerfunction',
  undefined as unknown as ChannelWriter,
  undefined as unknown as ChannelReader,
];

// Function signatures
type _InitOpts = InitOptions;
type _IsSdk = ISdk;
type _HttpReq = HttpRequest;
type _HttpRes = HttpResponse;
type _Trigger = Trigger;
type _StreamRef = StreamChannelRef;

// Verify the IIIInvocationError class
const _err = new IIIInvocationError({ code: 'TIMEOUT', message: 'test', function_id: 'fn' });
const _errCode: string = _err.code;
const _errMsg: string = _err.message;
const _errFn: string | undefined = _err.function_id;
