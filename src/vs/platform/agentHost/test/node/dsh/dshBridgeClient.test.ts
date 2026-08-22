/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { PassThrough } from 'stream';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DshBridgeClient, DshJsonRpcError, type IDshBridgeTransport } from '../../../node/dsh/dshBridgeClient.js';

// In-memory fake bridge built from two PassThrough streams, mirroring the
// codex client test's fake peer: the test's "bridge" side reads what the
// client writes and pushes frames back on the client's stdout.

interface IFakeBridge {
	readonly transport: IDshBridgeTransport;
	/** Lines the client wrote (sent to the bridge). */
	readonly outbound: PassThrough;
	push(message: object): void;
	exit(code: number | null, signal?: NodeJS.Signals | null): void;
	dispose(): void;
}

function makeFakeBridge(): IFakeBridge {
	const clientStdin = new PassThrough();
	const clientStdout = new PassThrough();
	const exitEmitter = new Emitter<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>();
	const onceExitListeners: ((e: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)[] = [];
	let killed = false;
	const fireExit = (e: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => {
		exitEmitter.fire(e);
		for (const listener of onceExitListeners.splice(0)) {
			listener(e);
		}
	};
	return {
		transport: {
			stdin: clientStdin,
			stdout: clientStdout,
			kill(signal) {
				if (killed) {
					return false;
				}
				killed = true;
				fireExit({ code: null, signal: signal ?? null });
				return true;
			},
			onExit: exitEmitter.event,
			onExitOnce(listener) {
				onceExitListeners.push(listener);
			},
		},
		outbound: clientStdin,
		push(message: object) {
			clientStdout.write(JSON.stringify(message) + '\n');
		},
		exit(code, signal = null) {
			fireExit({ code, signal });
		},
		dispose() {
			onceExitListeners.length = 0;
			exitEmitter.dispose();
			clientStdin.destroy();
			clientStdout.destroy();
		},
	};
}

/** Consume the next newline-delimited JSON frame the client wrote. */
function readNextFrame(stream: PassThrough, timeoutMs = 1_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let buf = '';
		const onData = (chunk: Buffer | string) => {
			buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			const nl = buf.indexOf('\n');
			if (nl < 0) {
				return;
			}
			const line = buf.slice(0, nl).trim();
			cleanup();
			try {
				resolve(JSON.parse(line));
			} catch (err) {
				reject(err);
			}
		};
		const onEnd = () => {
			cleanup();
			reject(new Error('stream ended before frame arrived'));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error('timed out waiting for frame'));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			stream.off('data', onData);
			stream.off('end', onEnd);
		};
		stream.on('data', onData);
		stream.on('end', onEnd);
	});
}

suite('DshBridgeClient', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('request writes a jsonrpc 2.0 frame and resolves on result', async () => {
		const bridge = makeFakeBridge();
		const client = new DshBridgeClient(bridge.transport);
		try {
			const responsePromise = client.request('session/create', { cwd: '/tmp/x' });
			const sent = await readNextFrame(bridge.outbound) as { jsonrpc: string; id: number; method: string; params: unknown };
			assert.strictEqual(sent.jsonrpc, '2.0');
			assert.strictEqual(sent.method, 'session/create');
			assert.deepStrictEqual(sent.params, { cwd: '/tmp/x' });
			assert.strictEqual(typeof sent.id, 'number');

			bridge.push({ jsonrpc: '2.0', id: sent.id, result: { sessionId: 's-1' } });
			assert.deepStrictEqual(await responsePromise, { sessionId: 's-1' });
		} finally {
			client.dispose();
			bridge.dispose();
		}
	});

	test('request without params omits the params member', async () => {
		const bridge = makeFakeBridge();
		const client = new DshBridgeClient(bridge.transport);
		try {
			const responsePromise = client.request('session/list');
			const sent = await readNextFrame(bridge.outbound) as { id: number; params?: unknown };
			assert.strictEqual(sent.params, undefined);
			bridge.push({ jsonrpc: '2.0', id: sent.id, result: { sessions: [] } });
			await responsePromise;
		} finally {
			client.dispose();
			bridge.dispose();
		}
	});

	test('error envelope rejects with DshJsonRpcError', async () => {
		const bridge = makeFakeBridge();
		const client = new DshBridgeClient(bridge.transport);
		try {
			const responsePromise = client.request('session/prompt', { sessionId: 'nope', content: 'x' });
			const sent = await readNextFrame(bridge.outbound) as { id: number };
			bridge.push({ jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'session is not live' } });
			await assert.rejects(responsePromise, (err: unknown) => {
				assert.ok(err instanceof DshJsonRpcError, 'expected DshJsonRpcError');
				assert.strictEqual(err.code, -32603);
				assert.match(err.message, /not live/);
				return true;
			});
		} finally {
			client.dispose();
			bridge.dispose();
		}
	});

	test('notifications reach the registered handler', async () => {
		const bridge = makeFakeBridge();
		const client = new DshBridgeClient(bridge.transport);
		try {
			const received: unknown[] = [];
			const handle = client.onNotification('session/event', params => received.push(params));
			bridge.push({ jsonrpc: '2.0', method: 'session/event', params: { sessionId: 's-1', event: { type: 'turn/start', seq: 4, time: 1, data: { turn: 1 } } } });
			await new Promise(r => setImmediate(r));
			assert.strictEqual(received.length, 1);
			assert.strictEqual((received[0] as { sessionId: string }).sessionId, 's-1');
			handle.dispose();
		} finally {
			client.dispose();
			bridge.dispose();
		}
	});

	test('server request with string id (approval passthrough) is answered through onRequest', async () => {
		const bridge = makeFakeBridge();
		const client = new DshBridgeClient(bridge.transport);
		try {
			const handle = client.onRequest('approval/request', params => {
				const request = params as { toolName: string };
				assert.strictEqual(request.toolName, 'bridge_probe');
				return { result: { outcome: 'allowed-once' } };
			});
			bridge.push({ jsonrpc: '2.0', id: 'req_abc123', method: 'approval/request', params: { requestId: 'apr_1', sessionId: 's-1', toolName: 'bridge_probe', callId: 'call_1' } });
			const reply = await readNextFrame(bridge.outbound) as { jsonrpc: string; id: string; result: { outcome: string } };
			assert.strictEqual(reply.jsonrpc, '2.0');
			assert.strictEqual(reply.id, 'req_abc123');
			assert.deepStrictEqual(reply.result, { outcome: 'allowed-once' });
			handle.dispose();
		} finally {
			client.dispose();
			bridge.dispose();
		}
	});

	test('server request without a handler is answered method-not-found', async () => {
		const bridge = makeFakeBridge();
		const client = new DshBridgeClient(bridge.transport);
		try {
			bridge.push({ jsonrpc: '2.0', id: 'req_zzz', method: 'unknown/thing', params: {} });
			const reply = await readNextFrame(bridge.outbound) as { id: string; error: { code: number } };
			assert.strictEqual(reply.id, 'req_zzz');
			assert.strictEqual(reply.error.code, -32601);
		} finally {
			client.dispose();
			bridge.dispose();
		}
	});

	test('process exit rejects pending requests', async () => {
		const bridge = makeFakeBridge();
		const client = new DshBridgeClient(bridge.transport);
		try {
			const responsePromise = client.request('initialize');
			await readNextFrame(bridge.outbound);
			bridge.exit(1);
			await assert.rejects(responsePromise, (err: unknown) => {
				assert.ok(err instanceof DshJsonRpcError);
				assert.match(err.message, /exited/);
				return true;
			});
			// Further requests fail fast.
			await assert.rejects(client.request('session/list'), (err: unknown) => err instanceof DshJsonRpcError);
		} finally {
			client.dispose();
			bridge.dispose();
		}
	});

	test('dispose rejects pending requests with CancellationError', async () => {
		const bridge = makeFakeBridge();
		const client = new DshBridgeClient(bridge.transport);
		const responsePromise = client.request('initialize');
		await readNextFrame(bridge.outbound);
		client.dispose();
		await assert.rejects(responsePromise, (err: unknown) => err instanceof CancellationError);
		bridge.dispose();
	});
});
