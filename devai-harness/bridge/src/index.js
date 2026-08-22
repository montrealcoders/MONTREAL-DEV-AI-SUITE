/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * devai-bridge: the DEV-AI Suite side door into the embedded DSH runtime,
 * composed as an ordinary dsh plugin (no core fork). It serves *bridge
 * protocol v0* — JSON-RPC 2.0 over newline-delimited JSON on stdio — so the
 * IDE's Agent Host child-process client can:
 *
 *  - create / list / resume / close harness sessions (`session/*` methods),
 *  - submit user messages (`session/prompt`) and interrupt turns,
 *  - receive every durable session event as a `session/event` notification
 *    (raw dsh `SessionEvent`s: `turn/*`, `user/message`, `assistant/chunk`,
 *    `assistant/message`, `tool/*`, audit records, …) plus `session/status`
 *    agent lifecycle transitions,
 *  - answer `approval/request` server->client requests, preserving the
 *    harness's fail-closed approval seam.
 *
 * The full wire contract is documented in ../README.md, versioned against the
 * pinned dsh runtime (0.1.1-rc.2). This file is plain JavaScript because the
 * Loader imports it through `node_modules`, where Node performs no type
 * stripping.
 *
 * Stdout belongs to the protocol: a composition that loads this plugin must
 * not mount a stdout logger. Diagnostics go to stderr.
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
// Imported rather than restated, like @deepseek-ai/dsh-persona does: the
// prompt registry declares the persona slot a preset shadows, and a drifted
// copy would land the preset persona BESIDE the deployment's instead of
// replacing it.
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt';

export const name = 'devai-bridge';
// The agent factory, persistence, and the prompt registry (preset personas
// register agent-scoped sections) are hard requirements; the optional llm and
// loader services are read with ctx.get().
export const inject = ['agents', 'sessionPersistence', 'systemPrompt'];

/** Wire version answered by `initialize`. Bump on any breaking wire change. */
export const BRIDGE_PROTOCOL_VERSION = 0;

/** The exact dsh runtime pin this bridge build is contracted against. */
export const BRIDGE_RUNTIME_PIN = '0.1.1-rc.2';

/** Approval outcomes the wire may answer; anything else fails closed. */
const APPROVAL_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/**
 * Read a required string field out of untrusted wire params.
 * @param {Record<string, unknown> | undefined} params raw request params.
 * @param {string} key field name.
 * @returns {string} the non-empty string value.
 */
function requireString(params, key) {
	const value = params?.[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`devai-bridge: "${key}" must be a non-empty string`);
	}
	return value;
}

/**
 * Normalize `session/prompt` content: a plain string becomes one text block,
 * an array passes through verbatim (the runtime validates block shapes).
 * @param {unknown} content wire content field.
 * @returns {object[]} content blocks for the user message.
 */
function toContentBlocks(content) {
	if (typeof content === 'string') {
		return [{ type: 'text', text: content }];
	}
	if (Array.isArray(content)) {
		return content;
	}
	throw new Error('devai-bridge: "content" must be a string or an array of content blocks');
}

/**
 * Bridge protocol v0 server over one booted harness context and one
 * transport peer. Construction subscribes to session/agent events and the
 * approval seam; `shutdown()` releases bridge-owned agents and subscriptions
 * while the surrounding context keeps running.
 */
export class DevaiBridgeServer {
	/**
	 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
	 * @param {import('@deepseek-ai/dsh-sdk-protocol').JsonRpcLineTransport} transport wire peer.
	 * @param {Record<string, { persona: string }>} [presets] session presets by id (config-supplied).
	 */
	constructor(ctx, transport, presets = {}) {
		this.ctx = ctx;
		this.transport = transport;
		this.presets = presets;
		/** @type {Map<string, { handle: { agent: any; dispose(): Promise<void> } }>} */
		this.sessions = new Map();
		/** @type {(() => void)[]} */
		this.disposers = [];
		this.shuttingDown = false;
		/** @type {Promise<Record<string, never>> | undefined} */
		this.shutdownTask = undefined;

		// Every durable session fact streams to the client, tagged by session
		// id; the client filters for the sessions it drives. Subagent child
		// sessions stream through the same feed, keyed by their own ids.
		this.disposers.push(ctx.on('session/event', (session, event) => {
			this.transport.notify('session/event', { sessionId: String(session.id), event });
		}));
		this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
			this.transport.notify('session/status', { sessionId: String(agent.session.id), status });
		}));

		// Approval answerer: claim requests for bridge-owned agents, delegate
		// everything else down the waterfall. A transport failure or an
		// unrecognized answer resolves 'unavailable' so the seam stays
		// fail-closed; an aborted request resolves 'cancelled'.
		const server = this;
		this.disposers.push(ctx.on('approval/request', function (req, next) {
			if (!server.sessions.has(String(req.agent.id))) {
				return next();
			}
			return server.requestApproval(req);
		}));
	}

	/**
	 * Forward one approval question to the client and map its answer.
	 * @param {{ agent: any; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }} req the pending decision.
	 * @returns {Promise<string>} an approval outcome.
	 */
	async requestApproval(req) {
		const params = {
			requestId: `apr_${randomUUID().replaceAll('-', '')}`,
			sessionId: String(req.agent.id),
			toolName: req.toolName,
			...(req.callId === undefined ? {} : { callId: String(req.callId) }),
			...(req.reason === undefined ? {} : { reason: req.reason }),
		};
		try {
			const answer = await this.transport.request('approval/request', params, req.signal);
			const outcome = answer && typeof answer === 'object' ? (/** @type {Record<string, unknown>} */ (answer)).outcome : undefined;
			if (typeof outcome === 'string' && APPROVAL_OUTCOMES.has(outcome)) {
				return outcome;
			}
			console.error(`devai-bridge: approval answer carried an unrecognized outcome (${String(outcome)}); failing closed`);
			return 'unavailable';
		} catch (error) {
			if (req.signal?.aborted) {
				return 'cancelled';
			}
			console.error(`devai-bridge: approval round-trip failed (${error instanceof Error ? error.message : String(error)}); failing closed`);
			return 'unavailable';
		}
	}

	/**
	 * Answer the readiness handshake with the wire version, runtime pin, and
	 * the registered model provider routes.
	 * @returns {Promise<object>} handshake payload.
	 */
	async initialize() {
		// Do not advertise readiness until the composed tree has settled, so
		// async sibling capabilities are visible to the first session.
		await this.ctx.get('loader')?.await();
		const llm = this.ctx.get('llm');
		return {
			protocol: { name: 'devai-bridge', version: BRIDGE_PROTOCOL_VERSION },
			runtime: { name: 'dsh', pin: BRIDGE_RUNTIME_PIN },
			providers: llm === undefined ? [] : llm.listProviders().map(entry => ({ id: entry.id, name: entry.name })),
			presets: Object.keys(this.presets),
		};
	}

	/**
	 * Resolve one preset id against the configured presets, or fail loud —
	 * a client naming a preset expects the persona to apply, so silently
	 * creating a default session would misrepresent the session it returns.
	 * @param {string} preset the requested preset id.
	 * @returns {{ persona: string }} the preset definition.
	 */
	requirePreset(preset) {
		const found = this.presets[preset];
		if (found === undefined || typeof found.persona !== 'string' || found.persona.length === 0) {
			throw new Error(`devai-bridge: unknown preset: ${preset} (configured: ${Object.keys(this.presets).join(', ') || 'none'})`);
		}
		return found;
	}

	/**
	 * Agent setup registering the preset persona as this agent's own
	 * `deployment:persona` section — the agent-scoped registration shadows
	 * the composition's default persona for exactly this session, the same
	 * mechanism `@deepseek-ai/dsh-persona` and subagent child personas use.
	 * @param {string} persona the persona prose.
	 * @returns {(agentCtx: import('@deepseek-ai/cordis').Context) => void} the setup callback.
	 */
	personaSetup(persona) {
		return agentCtx => {
			agentCtx.systemPrompt.section({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: persona });
		};
	}

	/**
	 * Create a fresh session (and its driving agent).
	 * @param {Record<string, unknown> | undefined} params optional sessionId, cwd, provider, model.
	 * @returns {Promise<{ sessionId: string }>} the live session identity.
	 */
	async createSession(params) {
		this.assertServing();
		const sessionId = typeof params?.sessionId === 'string' && params.sessionId.length > 0 ? params.sessionId : randomUUID();
		if (this.sessions.has(sessionId)) {
			throw new Error(`devai-bridge: session already live: ${sessionId}`);
		}
		// The composition's default model selection fills whatever the caller
		// left unspecified, mirroring how the dsh entry points create agents.
		const defaults = this.ctx.get('agentDefaultModel')?.currentSelection();
		const provider = typeof params?.provider === 'string' ? params.provider : defaults?.provider;
		const model = typeof params?.model === 'string' ? params.model : defaults?.model;
		const cwd = typeof params?.cwd === 'string' && params.cwd.length > 0 ? resolve(params.cwd) : undefined;
		// A named preset must exist; its persona composes into the agent's
		// scoped world during setup (before publication), and the id is
		// recorded as durable session meta so resume can re-apply it.
		const preset = typeof params?.preset === 'string' && params.preset.length > 0 ? params.preset : undefined;
		const personaSetup = preset === undefined ? undefined : this.personaSetup(this.requirePreset(preset).persona);
		const meta = {
			...(cwd === undefined ? {} : { cwd }),
			...(preset === undefined ? {} : { agentPreset: preset }),
		};
		const handle = await this.ctx.agents.create({
			sessionId: SessionId(sessionId),
			...(Object.keys(meta).length === 0 ? {} : { meta }),
			...(personaSetup === undefined ? {} : { setup: personaSetup }),
			...(provider === undefined && model === undefined ? {} : {
				agentOptions: {
					...(provider === undefined ? {} : { provider }),
					...(model === undefined ? {} : { model }),
				},
			}),
		});
		this.sessions.set(sessionId, { handle });
		return { sessionId };
	}

	/**
	 * List persisted sessions from the composed persistence backend, marking
	 * the ones that are currently live in the agent registry.
	 * @returns {Promise<{ sessions: object[] }>} lightweight session headers.
	 */
	async listSessions() {
		const headers = await this.ctx.sessionPersistence.list();
		return {
			sessions: headers.map(header => ({
				sessionId: String(header.id),
				createdAt: header.createdAt,
				...(header.cwd === undefined ? {} : { cwd: header.cwd }),
				...(header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) }),
				...(header.agentPreset === undefined ? {} : { preset: header.agentPreset }),
				live: this.ctx.agents.get(header.id) !== undefined,
			})),
		};
	}

	/**
	 * Resume a persisted session onto a live agent and return its replayed
	 * event log so the client can render history. Resuming a session this
	 * bridge already drives just returns the current log.
	 * @param {Record<string, unknown> | undefined} params carries sessionId.
	 * @returns {Promise<{ sessionId: string; events: readonly object[] }>} identity plus full log.
	 */
	async resumeSession(params) {
		this.assertServing();
		const sessionId = requireString(params, 'sessionId');
		let rec = this.sessions.get(sessionId);
		if (rec === undefined) {
			// Re-apply the persisted preset persona: the durable header names
			// the preset the session was created with; a preset the current
			// composition no longer defines degrades to composition defaults
			// (with a stderr note) rather than bricking the resume.
			const headers = await this.ctx.sessionPersistence.list();
			const persistedPreset = headers.find(header => String(header.id) === sessionId)?.agentPreset;
			let personaSetup;
			if (persistedPreset !== undefined) {
				const found = this.presets[persistedPreset];
				if (found === undefined || typeof found.persona !== 'string' || found.persona.length === 0) {
					console.error(`devai-bridge: session ${sessionId} was created with preset "${persistedPreset}", which the current composition does not define; resuming without its persona`);
				} else {
					personaSetup = this.personaSetup(found.persona);
				}
			}
			// Fill the composition's default model selection exactly like
			// createSession does: a resumed agent starts from a fresh scoped
			// world, so without this the next turn fails with "no
			// provider/model" (previously masked because the contract test's
			// turn/end waiter also matched error turn-ends).
			const defaults = this.ctx.get('agentDefaultModel')?.currentSelection();
			const handle = await this.ctx.agents.resume({
				resumeSessionId: SessionId(sessionId),
				...(personaSetup === undefined ? {} : { setup: personaSetup }),
				...(defaults?.provider === undefined && defaults?.model === undefined ? {} : {
					agentOptions: {
						...(defaults?.provider === undefined ? {} : { provider: defaults.provider }),
						...(defaults?.model === undefined ? {} : { model: defaults.model }),
					},
				}),
			});
			rec = { handle };
			this.sessions.set(sessionId, rec);
		}
		return { sessionId, events: rec.handle.agent.session.events };
	}

	/**
	 * Queue one identified user prompt; later activity streams via
	 * `session/event` and is not assigned to this request.
	 * @param {Record<string, unknown> | undefined} params carries sessionId and content.
	 * @returns {Promise<{ messageId: string }>} the durable message identity.
	 */
	async prompt(params) {
		const sessionId = requireString(params, 'sessionId');
		const rec = this.requireLiveSession(sessionId);
		const message = createUserMessage({ content: toContentBlocks(params?.content), source: { kind: 'user' } });
		rec.handle.agent.followup(message);
		return { messageId: message.id };
	}

	/**
	 * Abort the session's active turn (queued work is discarded, the session
	 * stays live for the next prompt).
	 * @param {Record<string, unknown> | undefined} params carries sessionId.
	 * @returns {Promise<Record<string, never>>} empty result.
	 */
	async interrupt(params) {
		const sessionId = requireString(params, 'sessionId');
		const rec = this.requireLiveSession(sessionId);
		rec.handle.agent.cancel({ kind: 'user' });
		return {};
	}

	/**
	 * Release a live session's agent without deleting durable data; the
	 * session can be resumed later.
	 * @param {Record<string, unknown> | undefined} params carries sessionId.
	 * @returns {Promise<Record<string, never>>} empty result.
	 */
	async closeSession(params) {
		const sessionId = requireString(params, 'sessionId');
		const rec = this.sessions.get(sessionId);
		if (rec === undefined) {
			return {};
		}
		this.sessions.delete(sessionId);
		await rec.handle.dispose();
		return {};
	}

	/**
	 * Dispose bridge-owned agents and subscriptions to quiescence. The
	 * surrounding context remains running; process exit belongs to `apply`.
	 * @returns {Promise<Record<string, never>>} empty result.
	 */
	shutdown() {
		this.shutdownTask ??= this.performShutdown();
		return this.shutdownTask;
	}

	async performShutdown() {
		this.shuttingDown = true;
		const records = [...this.sessions.values()];
		this.sessions.clear();
		const failures = [];
		while (this.disposers.length > 0) {
			try {
				this.disposers.pop()?.();
			} catch (error) {
				failures.push(error);
			}
		}
		const teardown = await Promise.allSettled(records.map(rec => Promise.resolve().then(() => rec.handle.dispose())));
		failures.push(...teardown.filter(result => result.status === 'rejected').map(result => result.reason));
		if (failures.length === 1) {
			throw failures[0];
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, 'devai-bridge teardown failed');
		}
		return {};
	}

	/**
	 * Dispatch one JSON-RPC request; an unknown method throws, which the
	 * transport maps to a JSON-RPC error response.
	 * @param {string} method wire method name.
	 * @param {Record<string, unknown> | undefined} params raw wire params.
	 * @returns {Promise<unknown>} the handler result.
	 */
	handleRequest(method, params) {
		switch (method) {
			case 'initialize': return this.initialize();
			case 'session/create': return this.createSession(params);
			case 'session/list': return this.listSessions();
			case 'session/resume': return this.resumeSession(params);
			case 'session/prompt': return this.prompt(params);
			case 'session/interrupt': return this.interrupt(params);
			case 'session/close': return this.closeSession(params);
			case 'shutdown': return this.shutdown();
			default: throw new Error(`devai-bridge: unknown method: ${method}`);
		}
	}

	assertServing() {
		if (this.shuttingDown) {
			throw new Error('devai-bridge is shutting down');
		}
	}

	/**
	 * Look up a bridge-owned session and validate its agent is still the one
	 * registered — an out-of-band reload disposes agents while this record
	 * survives, and a retained stale agent would accept followups silently.
	 * @param {string} sessionId the live session identity.
	 * @returns {{ handle: { agent: any; dispose(): Promise<void> } }} the record.
	 */
	requireLiveSession(sessionId) {
		const rec = this.sessions.get(sessionId);
		if (rec === undefined) {
			throw new Error(`devai-bridge: session is not live on this bridge: ${sessionId}`);
		}
		if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
			throw new Error(`devai-bridge: session agent was disposed outside the bridge: ${sessionId}`);
		}
		return rec;
	}
}

/**
 * Serve bridge protocol v0 over the configured streams (production: process
 * stdio). Effect disposal stops serving without exiting; a `shutdown`
 * request additionally flushes the response, disposes the complete root
 * runtime, and exits 0, mirroring the dsh SDK server's contract.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {{ presets?: Record<string, { persona: string }>; input?: import('node:stream').Readable; output?: import('node:stream').Writable; exit?: (code: number) => void }} [config] session presets plus runtime-only transport hooks.
 */
export function apply(ctx, config = {}) {
	const rootFiber = ctx.root.fiber;
	const input = config.input ?? process.stdin;
	const output = config.output ?? process.stdout;
	const exit = config.exit ?? ((code) => { process.exit(code); });

	const transport = new JsonRpcLineTransport(input, output);
	const server = new DevaiBridgeServer(ctx, transport, config.presets ?? {});

	/** @type {Promise<void> | undefined} */
	let exitTask;
	const disposeAndExit = () => {
		exitTask ??= (async () => {
			await Promise.allSettled([Promise.resolve().then(() => transport.flush())]);
			await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
			exit(0);
		})();
		return exitTask;
	};

	transport.onRequest(async (method, params) => {
		const result = await server.handleRequest(method, params);
		if (method === 'shutdown') {
			// Run after the response is written; the task flushes, disposes the
			// root (persistence included), and exits.
			setImmediate(() => { void disposeAndExit(); });
		}
		return result;
	});

	ctx.effect(() => {
		transport.start();
		return async () => {
			await server.shutdown();
			transport.close();
		};
	}, 'devai-bridge.serve');
}
