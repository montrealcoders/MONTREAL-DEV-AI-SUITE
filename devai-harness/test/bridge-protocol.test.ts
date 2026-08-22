/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Contract test of bridge protocol v0 (Phase 2): spawn the real bridge-mode
 * boot as a child process, drive it over JSON-RPC/NDJSON stdio exactly as the
 * IDE's Agent Host does, and assert the full session lifecycle:
 *
 *  1. `initialize` answers the protocol version, runtime pin, and providers;
 *  2. `session/create` + `session/prompt` run a model turn against a local
 *     OpenAI-compatible mock endpoint (no network beyond loopback);
 *  3. the model's `bridge_probe` tool call — gated `ask` by a third-party
 *     fixture plugin — round-trips an `approval/request` to this client,
 *     whose `allowed-once` answer lets the tool run;
 *  4. every durable fact streams back ordered as `session/event`
 *     notifications (turn/user/chunk/message/tool/approval-audit events);
 *  5. `session/list`, `session/close`, and `session/resume` restore the
 *     persisted history, and a post-resume prompt runs a second turn;
 *  6. `shutdown` flushes, disposes the runtime, and exits 0.
 *
 * Plain Node. Exits 0 on success, 1 on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const componentDir = join(testDir, '..');
const home = join(componentDir, '.tmp-bridge-test-home');
const fixtureDir = join(testDir, 'fixtures', 'dsh-plugin-approval-probe');

// A fresh harness home per run; DSH_HOME must be set before the boot module
// (and through it dsh-home-paths) is imported.
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;

const { ensureDevaiProfile } = await import('../src/boot.ts');

// ---------------------------------------------------------------------------
// 1. Seed the devai profile and install the approval-probe fixture through
// the ecosystem's package-manager flow (pack first, so the install is a real
// third-party artifact). Its composition entry goes into the profile's own
// cordis.patch.yml — the same file a user (or Phase 3's settings UI) edits.
const profile = ensureDevaiProfile();
const tarball = execFileSync('npm', ['pack', '--silent', fixtureDir], { cwd: home, encoding: 'utf8' }).trim();
execFileSync('npm', [
	'install', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', '--legacy-peer-deps',
	join(home, tarball),
], { cwd: profile.dir, stdio: 'inherit' });
writeFileSync(join(profile.dir, 'cordis.patch.yml'), [
	'# Bridge contract test layer: mount the installed third-party probe plugin.',
	'- insert:',
	'    - id: approval-probe',
	'      name: dsh-plugin-approval-probe',
	'',
].join('\n'));

// ---------------------------------------------------------------------------
// 2. Local OpenAI-compatible mock endpoint. Request routing:
//    - a `tool`-role message in the transcript => the turn after the probe
//      ran (or a resumed history) => finish with the text "done";
//    - otherwise, a request advertising the bridge_probe tool => emit one
//      bridge_probe tool call;
//    - otherwise (e.g. the session-title model call) => a short text.
interface CompletionRequest {
	messages?: { role?: string }[];
	tools?: { function?: { name?: string } }[];
}

function sse(response: ServerResponse, lines: string[]): void {
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const line of lines) {
		response.write(`data: ${line}\n\n`);
	}
	response.write('data: [DONE]\n\n');
	response.end();
}

const modelRequests: CompletionRequest[] = [];
const llmServer = createServer((request: IncomingMessage, response: ServerResponse) => {
	let body = '';
	request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
	request.on('end', () => {
		const parsed = JSON.parse(body) as CompletionRequest;
		modelRequests.push(parsed);
		const hasToolResult = parsed.messages?.some(message => message.role === 'tool') === true;
		const hasProbeTool = parsed.tools?.some(tool => tool.function?.name === 'bridge_probe') === true;
		if (hasToolResult) {
			sse(response, [
				'{"choices":[{"delta":{"role":"assistant","content":null}}]}',
				'{"choices":[{"delta":{"content":"done"}}]}',
				'{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":1}}',
			]);
		} else if (hasProbeTool) {
			sse(response, [
				'{"choices":[{"delta":{"role":"assistant","content":null}}]}',
				'{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_probe_1","type":"function","function":{"name":"bridge_probe","arguments":""}}]}}]}',
				'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"label\\":\\"e2e\\"}"}}]}}]}',
				'{"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
			]);
		} else {
			sse(response, [
				'{"choices":[{"delta":{"role":"assistant","content":"Probe Session"}}]}',
				'{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
			]);
		}
	});
});
await new Promise<void>(resolve => llmServer.listen(0, '127.0.0.1', resolve));
const llmAddress = llmServer.address();
if (llmAddress === null || typeof llmAddress === 'string') {
	throw new Error('mock completion server has no port');
}
const llmUrl = `http://127.0.0.1:${llmAddress.port}`;

// ---------------------------------------------------------------------------
// 3. Spawn the bridge-mode boot and speak NDJSON JSON-RPC 2.0 over its stdio,
// exactly as the IDE-side client does.
type Json = Record<string, unknown>;

class BridgeTestClient {
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	readonly notifications: { method: string; params: Json }[] = [];
	private waiters: (() => void)[] = [];
	onServerRequest: ((method: string, params: Json) => Json | Promise<Json>) | undefined;
	private readonly child: ChildProcessWithoutNullStreams;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			this.buffer += chunk;
			let newline: number;
			while ((newline = this.buffer.indexOf('\n')) >= 0) {
				const line = this.buffer.slice(0, newline).trim();
				this.buffer = this.buffer.slice(newline + 1);
				if (line.length > 0) {
					this.dispatch(JSON.parse(line) as Json);
				}
			}
		});
	}

	private dispatch(frame: Json): void {
		if (frame.id !== undefined && typeof frame.method === 'string') {
			// Server->client request (approval passthrough).
			const handler = this.onServerRequest;
			void Promise.resolve()
				.then(() => {
					if (!handler) { throw new Error(`unexpected server request: ${String(frame.method)}`); }
					return handler(frame.method as string, (frame.params ?? {}) as Json);
				})
				.then(
					result => this.write({ jsonrpc: '2.0', id: frame.id, result }),
					(error: unknown) => this.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
				);
			return;
		}
		if (frame.id !== undefined) {
			const pending = this.pending.get(frame.id as number);
			if (pending) {
				this.pending.delete(frame.id as number);
				if (frame.error !== undefined) {
					pending.reject(new Error(`bridge error: ${JSON.stringify(frame.error)}`));
				} else {
					pending.resolve(frame.result);
				}
			}
			return;
		}
		if (typeof frame.method === 'string') {
			this.notifications.push({ method: frame.method, params: (frame.params ?? {}) as Json });
			const waiters = this.waiters;
			this.waiters = [];
			for (const wake of waiters) { wake(); }
		}
	}

	private write(frame: Json): void {
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	request(method: string, params?: Json): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
		});
	}

	/** Resolve once a collected notification satisfies the predicate. */
	async waitForNotification(label: string, predicate: (method: string, params: Json) => boolean, timeoutMs = 120_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.notifications.some(entry => predicate(entry.method, entry.params))) {
				return;
			}
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for ${label}`);
			}
			await new Promise<void>(resolve => {
				this.waiters.push(resolve);
				setTimeout(resolve, 1000);
			});
		}
	}
}

const child = spawn(process.execPath, [join(componentDir, 'src', 'bridge-main.ts')], {
	cwd: componentDir,
	env: {
		...process.env,
		DSH_HOME: home,
		DEEPSEEK_API_KEY: 'test-key',
		DEEPSEEK_BASE_URL: llmUrl,
	},
	stdio: ['pipe', 'pipe', 'inherit'],
});
const childExit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
const client = new BridgeTestClient(child);

interface SessionEventEnvelope { sessionId: string; event: { type: string; seq: number; data: Record<string, unknown> } }

try {
	// -- initialize -----------------------------------------------------------
	const init = await client.request('initialize') as {
		protocol: { name: string; version: number };
		runtime: { name: string; pin: string };
		providers: { id: string }[];
		presets: string[];
	};
	assert.equal(init.protocol.name, 'devai-bridge');
	assert.equal(init.protocol.version, 0);
	assert.equal(init.runtime.pin, '0.1.1-rc.2');
	assert.ok(init.providers.some(provider => provider.id === 'deepseek-official'), 'deepseek-official route not advertised');
	// The product's profile presets are advertised, one per DEV-AI profile.
	assert.deepEqual([...init.presets].sort(), ['arquiteto', 'dev', 'po', 'qa', 'uxui']);

	// -- create + prompt + approval passthrough -------------------------------
	// An unknown preset fails the create loud instead of silently composing a
	// default session.
	await assert.rejects(client.request('session/create', { preset: 'devops' }), /unknown preset: devops/);

	const created = await client.request('session/create', { cwd: home, preset: 'qa' }) as { sessionId: string };
	assert.ok(created.sessionId.length > 0, 'session/create returned no id');
	const sid = created.sessionId;

	const approvals: Json[] = [];
	client.onServerRequest = (method, params) => {
		assert.equal(method, 'approval/request');
		approvals.push(params);
		return { outcome: 'allowed-once' };
	};

	const prompted = await client.request('session/prompt', { sessionId: sid, content: 'Run the probe.' }) as { messageId: string };
	assert.ok(prompted.messageId.length > 0, 'session/prompt returned no messageId');

	const isEvent = (params: Json, type: string): boolean => {
		const envelope = params as unknown as SessionEventEnvelope;
		return envelope.sessionId === sid && envelope.event?.type === type;
	};
	await client.waitForNotification('first turn/end', (method, params) => method === 'session/event' && isEvent(params, 'turn/end'));

	// The approval question round-tripped through this client.
	assert.equal(approvals.length, 1, `expected exactly one approval request, got ${approvals.length}`);
	assert.equal(approvals[0].sessionId, sid);
	assert.equal(approvals[0].toolName, 'bridge_probe');
	assert.ok(typeof approvals[0].callId === 'string' && approvals[0].callId.length > 0, 'approval request carried no callId');
	assert.equal(approvals[0].reason, 'bridge approval probe');

	// The durable facts streamed, ordered by seq, with the expected shape.
	const events = client.notifications
		.filter(entry => entry.method === 'session/event')
		.map(entry => entry.params as unknown as SessionEventEnvelope)
		.filter(envelope => envelope.sessionId === sid)
		.map(envelope => envelope.event);
	const seqs = events.map(event => event.seq);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'session/event notifications arrived out of order');
	const types = events.map(event => event.type);
	const indexOf = (type: string, predicate?: (event: { data: Record<string, unknown> }) => boolean): number =>
		events.findIndex(event => event.type === type && (predicate === undefined || predicate(event)));
	for (const required of ['turn/start', 'user/message', 'assistant/chunk', 'assistant/message', 'tool/call', 'tool/result', 'approval/asked', 'approval/decided', 'turn/end']) {
		assert.ok(types.includes(required), `missing streamed event ${required} (got: ${[...new Set(types)].join(', ')})`);
	}
	const toolCall = events[indexOf('tool/call')];
	assert.equal(toolCall.data.name, 'bridge_probe');
	const decided = events[indexOf('approval/decided')];
	assert.equal(decided.data.outcome, 'allowed-once');
	const toolResult = events[indexOf('tool/result')];
	assert.ok(JSON.stringify(toolResult.data).includes('probe:e2e'), 'tool result does not carry the probe output');
	const finalMessage = events.filter(event => event.type === 'assistant/message').at(-1)!;
	assert.ok(JSON.stringify(finalMessage.data).includes('done'), 'final assistant message does not carry the mock text');
	assert.ok(indexOf('turn/start') < indexOf('user/message'), 'turn/start must precede user/message');
	assert.ok(indexOf('user/message') < indexOf('assistant/chunk'), 'user/message must precede the stream');
	assert.ok(indexOf('tool/call') < indexOf('approval/asked'), 'tool/call must precede the approval audit');
	assert.ok(indexOf('tool/result') < events.length - 1 || types.at(-1) === 'turn/end', 'tool/result must precede turn/end');
	// Streaming really streamed: a text-delta chunk precedes its assembled message.
	const chunkIndex = indexOf('assistant/chunk', event => JSON.stringify(event.data).includes('text-delta'));
	assert.ok(chunkIndex >= 0 && chunkIndex < events.length - 1 && types.slice(chunkIndex).includes('assistant/message'), 'no text-delta chunk streamed before an assistant/message');

	// Status transitions streamed too.
	assert.ok(client.notifications.some(entry => entry.method === 'session/status' && (entry.params as Json).status === 'running'), 'no running session/status observed');

	// The QA preset's persona reached the model: some conversation request of
	// the first turn carries the persona marker (registered as the agent's
	// deployment:persona section).
	const personaMarker = 'perfil QA';
	const hasPersona = (request: CompletionRequest): boolean => JSON.stringify(request).includes(personaMarker);
	assert.ok(modelRequests.some(hasPersona), 'no model request carried the QA preset persona');

	// -- list / close / resume -------------------------------------------------
	await client.request('session/close', { sessionId: sid });
	const listed = await client.request('session/list') as { sessions: { sessionId: string; live: boolean; cwd?: string; preset?: string }[] };
	const row = listed.sessions.find(entry => entry.sessionId === sid);
	assert.ok(row, 'closed session missing from session/list');
	assert.equal(row.live, false, 'closed session still reported live');
	assert.equal(row.preset, 'qa', 'session/list must echo the durable preset meta');

	const resumed = await client.request('session/resume', { sessionId: sid }) as { sessionId: string; events: { type: string; data: Record<string, unknown> }[] };
	assert.equal(resumed.sessionId, sid);
	assert.ok(resumed.events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Run the probe.')), 'resumed history is missing the first prompt');
	assert.ok(resumed.events.some(event => event.type === 'tool/result'), 'resumed history is missing the tool result');

	// A post-resume prompt runs a fresh turn on the restored history — and the
	// resumed agent re-applied the persisted preset persona.
	const eventCountBefore = client.notifications.filter(entry => entry.method === 'session/event' && isEvent(entry.params, 'turn/end')).length;
	const modelRequestsBeforeResumeTurn = modelRequests.length;
	await client.request('session/prompt', { sessionId: sid, content: 'Say done again.' });
	await client.waitForNotification('post-resume turn/end', (method, params) =>
		method === 'session/event' && isEvent(params, 'turn/end')
		&& client.notifications.filter(entry => entry.method === 'session/event' && isEvent(entry.params, 'turn/end')).length > eventCountBefore);
	// The waiter above also matches error turn-ends, so pin the outcome: the
	// post-resume turn must have COMPLETED (the resumed agent got the default
	// provider/model restored) and its model request must carry the persona.
	const lastTurnEnd = client.notifications
		.filter(entry => entry.method === 'session/event' && isEvent(entry.params, 'turn/end'))
		.map(entry => (entry.params as unknown as SessionEventEnvelope).event)
		.at(-1)!;
	assert.deepEqual((lastTurnEnd.data as { reason?: { kind?: string } }).reason?.kind, 'completed', `post-resume turn did not complete: ${JSON.stringify(lastTurnEnd.data)}`);
	assert.ok(modelRequests.slice(modelRequestsBeforeResumeTurn).some(hasPersona), 'the post-resume turn did not carry the re-applied preset persona');

	// -- shutdown ---------------------------------------------------------------
	await client.request('shutdown');
	const exitCode = await childExit;
	assert.equal(exitCode, 0, `bridge process exited with ${exitCode}`);

	console.log(`devai-bridge contract: protocol v0 verified against dsh ${init.runtime.pin} — create/prompt/stream (${events.length} events), approval passthrough (allowed-once), list/close/resume + second turn, clean shutdown`);
} finally {
	try { child.kill('SIGKILL'); } catch { /* already gone */ }
	llmServer.close();
}

process.exit(0);
