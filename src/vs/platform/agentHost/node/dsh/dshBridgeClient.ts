/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Readable, Writable } from 'stream';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

// JSON-RPC 2.0 over NDJSON against the devai-bridge plugin of the embedded
// DSH runtime (bridge protocol v0, `dshBridgeProtocol.ts`). Unlike the codex
// app-server convention, the bridge writes the standard `"jsonrpc": "2.0"`
// field on every frame; this client writes it too and tolerates its absence
// on inbound frames. Ids are numbers on frames this client originates and
// opaque strings on server-originated requests (`req_<uuid>`), so the wire
// dispatch accepts both.

/**
 * Standard JSON-RPC error codes.
 *
 * @see https://www.jsonrpc.org/specification#error_object
 */
export const enum DshJsonRpcErrorCode {
	ParseError = -32700,
	InvalidRequest = -32600,
	MethodNotFound = -32601,
	InvalidParams = -32602,
	InternalError = -32603,
}

/** Error thrown when a bridge request responds with an `error` envelope. */
export class DshJsonRpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = 'DshJsonRpcError';
	}
}

interface IWireFrame {
	readonly jsonrpc?: string;
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/**
 * Result of a server->client request (the approval passthrough). Either a
 * successful result payload or a JSON-RPC error envelope.
 */
export type DshServerRequestHandlerResult<R = unknown> =
	| { readonly result: R; readonly error?: undefined }
	| { readonly result?: undefined; readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

/**
 * Subset of `ChildProcessWithoutNullStreams` the client uses, so tests can
 * pass an in-memory stream pair instead of a real spawned process. Mirrors
 * the codex transport shape (`codexAppServerClient.ts`).
 */
export interface IDshBridgeTransport {
	readonly stdin: Writable;
	readonly stdout: Readable;
	/** Force termination. Used as the grace force-kill fallback. */
	kill(signal?: NodeJS.Signals): boolean;
	/** Fires when the underlying process exits. */
	readonly onExit: Event<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
	/** Registers a one-shot exit listener that may outlive client disposal. */
	onExitOnce(listener: (e: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void): void;
}

/**
 * Generic JSON-RPC client over an {@link IDshBridgeTransport}. The client
 * knows nothing about the bridge's domain — it brokers requests and
 * notifications in both directions; `DshAgent` translates the traffic into
 * `IAgent` semantics.
 *
 * Lifecycle mirrors `CodexAppServerClient`: construction starts reading
 * stdout; `dispose()` sends EOF on stdin, waits up to the grace period for a
 * clean exit, then SIGKILLs. Outstanding requests reject with
 * {@link CancellationError} on dispose and with {@link DshJsonRpcError} when
 * the process exits underneath them.
 */
export interface IDshBridgeClient extends IDisposable {
	/** Fires once when the transport exits (clean or otherwise). */
	readonly onExit: Event<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
	/** Fires when the underlying transport rejects further writes. */
	readonly onTransportError: Event<Error>;
	/** Issue a request and await its typed response payload. */
	request<R = unknown>(method: string, params?: object): Promise<R>;
	/** Register a handler for a server-pushed notification (one per method). */
	onNotification(method: string, handler: (params: unknown) => void): IDisposable;
	/** Register a handler for a server-initiated request (one per method). */
	onRequest<R = unknown>(method: string, handler: (params: unknown) => Promise<DshServerRequestHandlerResult<R>> | DshServerRequestHandlerResult<R>): IDisposable;
}

interface IPendingRequest {
	resolve(value: unknown): void;
	reject(reason: unknown): void;
	readonly method: string;
}

const GRACE_KILL_MS = 2_000;

export class DshBridgeClient extends Disposable implements IDshBridgeClient {

	private readonly _onExit = this._register(new Emitter<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>());
	readonly onExit = this._onExit.event;

	private readonly _onTransportError = this._register(new Emitter<Error>());
	readonly onTransportError = this._onTransportError.event;

	private _nextId = 1;
	private readonly _pending = new Map<number, IPendingRequest>();
	private readonly _notificationHandlers = new Map<string, (params: unknown) => void>();
	private readonly _requestHandlers = new Map<string, (params: unknown) => Promise<DshServerRequestHandlerResult<unknown>>>();

	private _exited = false;
	private _disposed = false;
	private _buf = '';

	constructor(
		private readonly _transport: IDshBridgeTransport,
		private readonly _onLog?: (level: 'info' | 'warn' | 'error', message: string) => void,
		private readonly _graceKillMs = GRACE_KILL_MS,
	) {
		super();
		this._register(this._transport.onExit(e => this._handleExit(e)));
		this._transport.stdout.setEncoding?.('utf8');
		this._register(this._listenToStdout());
	}

	private _listenToStdout(): IDisposable {
		const onData = (chunk: string | Buffer) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			this._buf += text;
			let nl: number;
			while ((nl = this._buf.indexOf('\n')) >= 0) {
				const line = this._buf.slice(0, nl);
				this._buf = this._buf.slice(nl + 1);
				const trimmed = line.trim();
				if (trimmed.length === 0) {
					continue;
				}
				let parsed: IWireFrame;
				try {
					parsed = JSON.parse(trimmed) as IWireFrame;
				} catch {
					this._log('error', `parse error on line: ${trimmed.slice(0, 200)}`);
					continue;
				}
				this._dispatch(parsed);
			}
		};
		this._transport.stdout.on('data', onData);
		return toDisposable(() => this._transport.stdout.off('data', onData));
	}

	private _dispatch(frame: IWireFrame): void {
		// Server->client request: id plus method.
		if (frame.id !== undefined && typeof frame.method === 'string') {
			void this._handleServerRequest(frame.id, frame.method, frame.params);
			return;
		}
		// Response envelope: id plus result or error.
		if (frame.id !== undefined) {
			if (typeof frame.id !== 'number') {
				this._log('warn', `unsolicited response id=${String(frame.id)}`);
				return;
			}
			const pending = this._pending.get(frame.id);
			if (!pending) {
				this._log('warn', `unsolicited response id=${frame.id}`);
				return;
			}
			this._pending.delete(frame.id);
			if (frame.error) {
				pending.reject(new DshJsonRpcError(frame.error.code, frame.error.message, frame.error.data));
			} else {
				pending.resolve(frame.result);
			}
			return;
		}
		// Notification: method without id.
		if (typeof frame.method === 'string') {
			this._handleServerNotification(frame.method, frame.params);
			return;
		}
		this._log('warn', `unrecognized frame: ${JSON.stringify(frame).slice(0, 200)}`);
	}

	private async _handleServerRequest(id: string | number, method: string, params: unknown): Promise<void> {
		const handler = this._requestHandlers.get(method);
		if (!handler) {
			this._writeFrame({ jsonrpc: '2.0', id, error: { code: DshJsonRpcErrorCode.MethodNotFound, message: `Method not found: ${method}` } });
			return;
		}
		try {
			const result = await handler(params);
			if (result.error) {
				this._writeFrame({ jsonrpc: '2.0', id, error: result.error });
			} else {
				this._writeFrame({ jsonrpc: '2.0', id, result: result.result });
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._log('error', `handler for ${method} threw: ${message}`);
			this._writeFrame({ jsonrpc: '2.0', id, error: { code: DshJsonRpcErrorCode.InternalError, message } });
		}
	}

	private _handleServerNotification(method: string, params: unknown): void {
		const handler = this._notificationHandlers.get(method);
		if (!handler) {
			// Tolerate unhandled notifications (a newer bridge may add methods
			// this client does not map yet); warn so drops stay visible.
			this._log('warn', `dropping unhandled notification: ${method}`);
			return;
		}
		try {
			handler(params);
		} catch (err) {
			this._log('error', `notification handler ${method} threw: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _writeFrame(frame: unknown): boolean {
		if (this._exited || this._disposed) {
			return false;
		}
		try {
			this._transport.stdin.write(JSON.stringify(frame) + '\n');
			return true;
		} catch (err) {
			this._onTransportError.fire(err instanceof Error ? err : new Error(String(err)));
			return false;
		}
	}

	private _handleExit(e: { code: number | null; signal: NodeJS.Signals | null }): void {
		if (this._exited) {
			return;
		}
		this._exited = true;
		const reason = `dsh bridge exited (code=${e.code}, signal=${e.signal})`;
		for (const [id, pending] of this._pending) {
			pending.reject(new DshJsonRpcError(DshJsonRpcErrorCode.InternalError, `${reason}; request id=${id} (${pending.method}) aborted`));
		}
		this._pending.clear();
		this._onExit.fire(e);
	}

	request<R = unknown>(method: string, params?: object): Promise<R> {
		if (this._disposed) {
			return Promise.reject(new CancellationError());
		}
		if (this._exited) {
			return Promise.reject(new DshJsonRpcError(DshJsonRpcErrorCode.InternalError, 'transport has exited'));
		}
		const id = this._nextId++;
		return new Promise<R>((resolve, reject) => {
			this._pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
			const ok = this._writeFrame(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
			if (!ok) {
				this._pending.delete(id);
				reject(new DshJsonRpcError(DshJsonRpcErrorCode.InternalError, 'write failed; transport closed'));
			}
		});
	}

	onNotification(method: string, handler: (params: unknown) => void): IDisposable {
		this._notificationHandlers.set(method, handler);
		return toDisposable(() => {
			if (this._notificationHandlers.get(method) === handler) {
				this._notificationHandlers.delete(method);
			}
		});
	}

	onRequest<R = unknown>(method: string, handler: (params: unknown) => Promise<DshServerRequestHandlerResult<R>> | DshServerRequestHandlerResult<R>): IDisposable {
		const wrapped = async (params: unknown): Promise<DshServerRequestHandlerResult<unknown>> => {
			return await handler(params);
		};
		this._requestHandlers.set(method, wrapped);
		return toDisposable(() => {
			if (this._requestHandlers.get(method) === wrapped) {
				this._requestHandlers.delete(method);
			}
		});
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		// Reject anything still pending so callers don't hang.
		for (const pending of this._pending.values()) {
			pending.reject(new CancellationError());
		}
		this._pending.clear();
		// Graceful EOF on stdin (the bridge exits on EOF); SIGKILL after the
		// grace period if the process is still alive.
		try {
			this._transport.stdin.end();
		} catch { /* already closed */ }
		if (!this._exited) {
			const timer = setTimeout(() => {
				try {
					this._transport.kill('SIGKILL');
				} catch { /* already dead */ }
			}, this._graceKillMs) as unknown as { unref?(): void };
			this._transport.onExitOnce(() => {
				clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
			});
			timer.unref?.();
		}
		super.dispose();
	}

	private _log(level: 'info' | 'warn' | 'error', message: string): void {
		this._onLog?.(level, message);
	}
}

/**
 * Wrap a spawned child process into an {@link IDshBridgeTransport}. Tests use
 * an in-memory fake built around `node:stream` `PassThrough` pairs.
 */
export function dshTransportFromChildProcess(
	child: { stdin: Writable | null; stdout: Readable | null; kill: (signal?: NodeJS.Signals) => boolean; on: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown; once: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown; removeListener: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown },
): IDshBridgeTransport {
	if (!child.stdin || !child.stdout) {
		throw new Error('dsh bridge child process has no stdio pair');
	}
	return {
		stdin: child.stdin,
		stdout: child.stdout,
		kill: signal => child.kill(signal),
		onExit: Event.fromNodeEventEmitter(child, 'exit', (code: number | null, signal: NodeJS.Signals | null) => ({ code, signal })),
		onExitOnce: listener => child.once('exit', (code, signal) => listener({ code, signal })),
	};
}
