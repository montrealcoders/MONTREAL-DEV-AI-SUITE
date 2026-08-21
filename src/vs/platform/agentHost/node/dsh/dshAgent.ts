/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentSession, AgentHostDshHarnessRootEnvVar, DSH_AGENT_PROVIDER_ID, type AgentProvider, type AgentSignal, type IActiveClient, type IAgent, type IAgentChats, type IAgentCreateChatForkSource, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentCreateSessionConfig, type IAgentCreateSessionResult, type IAgentDescriptor, type IAgentMaterializeSessionEvent, type IAgentModelInfo, type IAgentResolveSessionConfigParams, type IAgentSessionConfigCompletionsParams, type IAgentSessionMetadata } from '../../common/agentService.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { ProtectedResourceMetadata, type AgentSelection, type MessageAttachment, type ModelSelection, type ToolDefinition } from '../../common/state/protocol/state.js';
import { ActionType, isChatAction, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import { buildDefaultChatUri, parseChatUri, type ChatInputAnswer, type ChatInputResponseKind, type ClientPluginCustomization, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import { DshBridgeClient, dshTransportFromChildProcess, type IDshBridgeClient } from './dshBridgeClient.js';
import { DSH_BRIDGE_PROTOCOL_VERSION, type IDshApprovalRequestParams, type IDshApprovalResponse, type IDshInitializeResult, type IDshSessionCreateResult, type IDshSessionEventNotification, type IDshSessionListResult, type IDshSessionPromptResult, type IDshSessionResumeResult, type IDshSessionStatusNotification } from './dshBridgeProtocol.js';
import { createDshSessionMapState, mapDshSessionEvent, replayDshEventsToTurns, type IDshSessionMapState } from './dshEventMapper.js';

// The DSH provider: surfaces the embedded DEV-AI Harness runtime
// (`devai-harness/`, the pinned dsh runtime composed by the `devai` profile)
// in the Agent Host. The runtime runs as a child process — its Node engine
// range and native helpers must not couple to the IDE's Electron — spawned
// on the bridge-mode boot entry and driven over bridge protocol v0
// (JSON-RPC/NDJSON stdio; see `devai-harness/bridge/README.md`). The shape
// deliberately mirrors `CodexAgent` (single-chat provider, provisional
// sessions materialized on first send, child-process JSON-RPC client), so
// the two backends stay reviewable side by side.

/**
 * Resolve the DEV-AI Harness component root: the `VSCODE_AGENT_HOST_DSH_HARNESS_ROOT`
 * env override wins, else the component shipped inside the application root
 * (dev: `<repo>/devai-harness`; built products: `resources/app/devai-harness`,
 * staged by the packaging pipeline).
 */
export function resolveDshHarnessRoot(env: NodeJS.ProcessEnv, appRoot: string): string {
	const override = env[AgentHostDshHarnessRootEnvVar];
	if (override) {
		return override;
	}
	return join(appRoot, 'devai-harness');
}

/** The bridge-mode boot entry {@link DshAgent} spawns inside a harness root. */
export function dshHarnessBridgeEntry(harnessRoot: string): string {
	return join(harnessRoot, 'src', 'bridge-main.ts');
}

/**
 * Whether the harness component is present (its bridge entry exists) for the
 * given environment. The registration sites use this so a build without the
 * component (or a broken override) degrades to "agent absent" instead of
 * registering a provider whose every session would fail.
 */
export function isDshHarnessInstalled(env: NodeJS.ProcessEnv, appRoot: string): boolean {
	return fs.existsSync(dshHarnessBridgeEntry(resolveDshHarnessRoot(env, appRoot)));
}

interface IDshSession {
	readonly sessionId: string;
	readonly sessionUri: URI;
	workingDirectory: URI | undefined;
	readonly mapState: IDshSessionMapState;
	/** Approval answers parked per tool callId; resolved by respondToPermissionRequest. */
	readonly pendingApprovals: PendingRequestRegistry<boolean>;
	/** Whether the bridge-side session exists (created or resumed). */
	materialized: boolean;
	/** Materialize via `session/resume` (persisted session) instead of `session/create`. */
	needsResume: boolean;
	materializedEventFired: boolean;
}

type ConnectionState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'starting'; readonly promise: Promise<IConnectionReady> }
	| ({ readonly kind: 'ready' } & IConnectionReady);

interface IConnectionReady {
	readonly client: IDshBridgeClient;
	readonly initialize: IDshInitializeResult;
}

export class DshAgent extends Disposable implements IAgent {

	readonly id: AgentProvider = DSH_AGENT_PROVIDER_ID;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _onDidMaterializeSession = this._register(new Emitter<IAgentMaterializeSessionEvent>());
	readonly onDidMaterializeSession = this._onDidMaterializeSession.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = new Map<string, IDshSession>();
	private _connection: ConnectionState = { kind: 'idle' };

	constructor(
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) {
		super();
	}

	// #region Connection

	/** Resolve the DEV-AI Harness component root (env override, else in-app). */
	private _resolveHarnessRoot(): string {
		return resolveDshHarnessRoot(process.env, this._environmentService.appRoot);
	}

	private _ensureConnection(): Promise<IConnectionReady> {
		if (this._connection.kind === 'ready') {
			return Promise.resolve(this._connection);
		}
		if (this._connection.kind === 'starting') {
			return this._connection.promise;
		}
		const promise = this._startConnection().then(ready => {
			this._connection = { kind: 'ready', ...ready };
			return ready;
		}).catch(err => {
			this._connection = { kind: 'idle' };
			throw err;
		});
		this._connection = { kind: 'starting', promise };
		return promise;
	}

	private async _startConnection(): Promise<IConnectionReady> {
		const root = this._resolveHarnessRoot();
		const entry = dshHarnessBridgeEntry(root);
		if (!fs.existsSync(entry)) {
			throw new Error(`DSH harness root not found: ${entry} (set ${AgentHostDshHarnessRootEnvVar} to the devai-harness component directory)`);
		}
		// The runtime needs a real Node (engine ^22.19 || >=24, with default
		// type stripping for the TS boot entry). Inside Electron, re-enter the
		// bundled Node via ELECTRON_RUN_AS_NODE; under plain Node (tests,
		// remote server) process.execPath already is one.
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (process.versions.electron) {
			env.ELECTRON_RUN_AS_NODE = '1';
		}
		this._logService.info(`[DSH] spawning ${process.execPath} ${entry}`);
		const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => this._logService.info(`[DSH stderr] ${String(chunk).trimEnd()}`));

		const client = new DshBridgeClient(dshTransportFromChildProcess(child), (level, msg) => {
			this._logService.info(`[DshClient ${level}] ${msg}`);
		});
		client.onExit(e => {
			this._logService.warn(`[DSH] bridge exited code=${e.code} signal=${e.signal}`);
			this._handleConnectionLost();
		});
		client.onTransportError(err => {
			this._logService.error(`[DSH] transport error: ${err.message}`);
			this._handleConnectionLost();
		});

		this._register(client.onNotification('session/event', params => this._handleSessionEvent(params as IDshSessionEventNotification)));
		this._register(client.onNotification('session/status', params => {
			const status = params as IDshSessionStatusNotification;
			this._logService.trace(`[DSH:${status.sessionId}] status=${status.status}`);
		}));
		this._register(client.onRequest('approval/request', params => this._handleApprovalRequest(params as IDshApprovalRequestParams)));

		let initialize: IDshInitializeResult;
		try {
			initialize = await client.request<IDshInitializeResult>('initialize');
			if (initialize.protocol.name !== 'devai-bridge' || initialize.protocol.version !== DSH_BRIDGE_PROTOCOL_VERSION) {
				throw new Error(`unsupported bridge protocol: ${initialize.protocol.name}/${initialize.protocol.version} (this client speaks devai-bridge/${DSH_BRIDGE_PROTOCOL_VERSION})`);
			}
		} catch (err) {
			client.dispose();
			try { child.kill('SIGKILL'); } catch { /* already dead */ }
			throw err;
		}
		this._logService.info(`[DSH] bridge ready: ${initialize.runtime.name} ${initialize.runtime.pin}, providers: ${initialize.providers.map(p => p.id).join(', ')}`);
		this._models.set(initialize.providers.map(provider => ({
			provider: this.id,
			id: provider.id,
			name: provider.name,
			supportsVision: false,
		})), undefined);
		return { client, initialize };
	}

	private _handleConnectionLost(): void {
		if (this._connection.kind === 'ready') {
			this._connection.client.dispose();
		}
		this._connection = { kind: 'idle' };
		// Bridge-side agents died with the process; durable logs survive, so
		// the next send re-materializes each session through resume.
		for (const session of this._sessions.values()) {
			if (session.materialized) {
				session.materialized = false;
				session.needsResume = true;
			}
		}
	}

	// #endregion

	// #region Event and approval routing

	private _fire(sessionUri: URI, action: SessionAction | ChatAction): void {
		this._onDidSessionProgress.fire({
			kind: 'action',
			resource: isChatAction(action) ? URI.parse(buildDefaultChatUri(sessionUri)) : sessionUri,
			action,
		});
	}

	private _handleSessionEvent(notification: IDshSessionEventNotification): void {
		const session = this._sessions.get(notification.sessionId);
		if (!session) {
			// Sessions this agent does not drive (e.g. subagent children the
			// runtime spawned) stream here too; v0 does not surface them.
			return;
		}
		for (const action of mapDshSessionEvent(session.mapState, notification.event)) {
			this._fire(session.sessionUri, action);
		}
	}

	private async _handleApprovalRequest(params: IDshApprovalRequestParams): Promise<{ readonly result: IDshApprovalResponse }> {
		const session = this._sessions.get(params.sessionId);
		if (!session) {
			this._logService.warn(`[DSH] approval request for unknown session ${params.sessionId}; failing closed`);
			return { result: { outcome: 'unavailable' } };
		}
		// Without a call id there is no tool-call card to attach the prompt
		// to; fail closed rather than invent a detached confirmation (the
		// upstream ACP bridge delegates these the same way).
		if (params.callId === undefined) {
			this._logService.warn(`[DSH:${params.sessionId}] approval request without callId (${params.toolName}); failing closed`);
			return { result: { outcome: 'unavailable' } };
		}
		const turnId = session.mapState.currentTurnId ?? generateUuid();
		const callId = params.callId;
		try {
			// The tool call streamed as auto-confirmed when it was requested
			// (the runtime owns approval policy); this Ready flips it back to
			// pending-confirmation for the user's decision — the protocol's
			// mid-execution re-confirmation flow. respondToPermissionRequest
			// resolves the parked deferred with the verdict.
			const approved = await session.pendingApprovals.registerAndFire(callId, () => {
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: callId,
					invocationMessage: params.reason ?? params.toolName,
					toolInput: params.toolName,
					confirmationTitle: params.reason ?? localize('dshAgent.approvalTitle', "Run {0}", params.toolName),
				});
			});
			return { result: { outcome: approved ? 'allowed-once' : 'rejected' } };
		} catch (err) {
			this._logService.warn(`[DSH:${params.sessionId}] approval round-trip failed (${err instanceof Error ? err.message : String(err)}); failing closed`);
			return { result: { outcome: 'unavailable' } };
		}
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		for (const session of this._sessions.values()) {
			if (session.pendingApprovals.respond(requestId, approved)) {
				return;
			}
		}
		this._logService.info(`[DSH] respondToPermissionRequest: unknown requestId=${requestId}`);
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// The bridge exposes no user-input surface in protocol v0.
	}

	// #endregion

	// #region Session lifecycle

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('dshAgent.displayName', "DSH"),
			description: localize('dshAgent.description', "DSH sessions on the embedded DEV-AI Harness runtime (plugin-configurable, compatible with DeepSeek Harness v0.1.1-rc.2 plugins)"),
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(_resource: string, _token: string): Promise<boolean> {
		// Model credentials live in the harness home's settings/credential
		// stores, not in an agent-host auth handshake.
		return false;
	}

	async createSession(config: IAgentCreateSessionConfig = {}): Promise<IAgentCreateSessionResult> {
		const sessionId = config.session ? AgentSession.id(config.session) : generateUuid();
		const sessionUri = config.session ?? AgentSession.uri(this.id, sessionId);
		const existing = this._sessions.get(sessionId);
		if (existing) {
			return { session: sessionUri, workingDirectory: existing.workingDirectory ?? config.workingDirectory, provisional: !existing.materialized };
		}
		// Provisional: the bridge-side session (and with it the harness boot)
		// materializes on the first sendMessage, so URI rebinds before the
		// first turn never leak runtime sessions. Mirrors CodexAgent.
		this._sessions.set(sessionId, {
			sessionId,
			sessionUri,
			workingDirectory: config.workingDirectory,
			mapState: createDshSessionMapState(),
			pendingApprovals: new PendingRequestRegistry<boolean>(),
			materialized: false,
			needsResume: false,
			materializedEventFired: false,
		});
		return { session: sessionUri, workingDirectory: config.workingDirectory, provisional: true };
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		// v0 exposes no provider-owned session configuration; composition
		// (profile patch layers) is the harness's configuration surface.
		return { schema: { type: 'object', properties: {} }, values: params.config ?? {} };
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	private _sessionUriFromChat(chat: URI): URI {
		const parsed = parseChatUri(chat);
		return parsed ? URI.parse(parsed.session) : chat;
	}

	private _requireSession(sessionUri: URI): IDshSession {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session) {
			throw new Error(`DSH session not found: ${sessionUri.toString()}`);
		}
		return session;
	}

	/** Create or resume the bridge-side session; idempotent per entry. */
	private async _materializeIfNeeded(session: IDshSession, client: IDshBridgeClient): Promise<void> {
		if (session.materialized) {
			return;
		}
		if (session.needsResume) {
			await client.request<IDshSessionResumeResult>('session/resume', { sessionId: session.sessionId });
			session.needsResume = false;
		} else {
			await client.request<IDshSessionCreateResult>('session/create', {
				sessionId: session.sessionId,
				...(session.workingDirectory?.scheme === 'file' ? { cwd: session.workingDirectory.fsPath } : {}),
			});
		}
		session.materialized = true;
		if (!session.materializedEventFired) {
			session.materializedEventFired = true;
			this._onDidMaterializeSession.fire({ session: session.sessionUri, workingDirectory: session.workingDirectory, project: undefined });
		}
	}

	private async _sendMessage(chat: URI, prompt: string, _attachments?: readonly MessageAttachment[], turnId?: string, workingDirectory?: URI): Promise<void> {
		const sessionUri = this._sessionUriFromChat(chat);
		const session = this._requireSession(sessionUri);
		if (workingDirectory && !session.materialized) {
			session.workingDirectory = workingDirectory;
		}
		const effectiveTurnId = turnId ?? generateUuid();
		session.mapState.currentTurnId = effectiveTurnId;
		session.mapState.lastPromptText = prompt;
		try {
			const conn = await this._ensureConnection();
			await this._materializeIfNeeded(session, conn.client);
			// Attachments are not part of bridge protocol v0; the prompt text
			// travels as one text block. Turn progress streams back via
			// session/event notifications, not this request.
			await conn.client.request<IDshSessionPromptResult>('session/prompt', { sessionId: session.sessionId, content: prompt });
		} catch (err) {
			if (err instanceof CancellationError) {
				this._fire(sessionUri, { type: ActionType.ChatTurnCancelled, turnId: effectiveTurnId, duration: 0 });
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			this._logService.error(`[DSH:${session.sessionId}] sendMessage failed: ${message}`);
			this._fire(sessionUri, { type: ActionType.ChatError, turnId: effectiveTurnId, duration: 0, error: { errorType: 'DshSendFailed', message } });
			this._fire(sessionUri, { type: ActionType.ChatTurnComplete, turnId: effectiveTurnId, duration: 0 });
		}
	}

	private async _abort(chat: URI): Promise<void> {
		const session = this._requireSession(this._sessionUriFromChat(chat));
		if (!session.materialized || this._connection.kind !== 'ready') {
			return;
		}
		await this._connection.client.request('session/interrupt', { sessionId: session.sessionId });
	}

	// Single-chat provider: a session owns exactly one (default) chat, like
	// Codex; peer-chat operations are unsupported.
	readonly chats: IAgentChats = {
		createChat: (_chat: URI, _options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult | void> => {
			throw new Error('DSH agent does not support multiple chats');
		},
		fork: (_chat: URI, _source: IAgentCreateChatForkSource, _options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult | void> => {
			throw new Error('DSH agent does not support chat forking');
		},
		disposeChat: (_chat: URI): Promise<void> => Promise.resolve(),
		sendMessage: (chat: URI, prompt: string, workingDirectory: URI | undefined, attachments?: readonly MessageAttachment[], turnId?: string, _senderClientId?: string): Promise<void> => {
			return this._sendMessage(chat, prompt, attachments, turnId, workingDirectory);
		},
		abort: (chat: URI): Promise<void> => this._abort(chat),
		changeModel: (chat: URI, model: ModelSelection): Promise<void> => {
			// v0 fixes the model at session creation (the composition's
			// default selection); a per-chat switch needs a bridge method.
			this._logService.info(`[DSH] changeModel to ${model.id} ignored for ${chat.toString()} (not in bridge protocol v0)`);
			return Promise.resolve();
		},
		changeAgent: (_chat: URI, _agent: AgentSelection | undefined): Promise<void> => Promise.resolve(),
		getMessages: (chat: URI): Promise<readonly Turn[]> => this.getSessionMessages(chat),
	};

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const sessionUri = this._sessionUriFromChat(session);
		const sessionId = AgentSession.id(sessionUri);
		const entry = this._sessions.get(sessionId);
		if (entry && !entry.materialized && !entry.needsResume) {
			// A provisional session has no bridge-side log yet.
			return [];
		}
		try {
			const conn = await this._ensureConnection();
			const resumed = await conn.client.request<IDshSessionResumeResult>('session/resume', { sessionId });
			if (entry) {
				entry.materialized = true;
				entry.needsResume = false;
			}
			return replayDshEventsToTurns(resumed.events);
		} catch (err) {
			this._logService.warn(`[DSH:${sessionId}] getSessionMessages failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		try {
			const conn = await this._ensureConnection();
			const listed = await conn.client.request<IDshSessionListResult>('session/list');
			return listed.sessions
				// Subagent child sessions belong to their parent's transcript,
				// not the session list.
				.filter(entry => entry.parentSession === undefined)
				.map(entry => {
					const known = this._sessions.get(entry.sessionId);
					return {
						session: known?.sessionUri ?? AgentSession.uri(this.id, entry.sessionId),
						startTime: entry.createdAt,
						modifiedTime: entry.createdAt,
						...(entry.cwd !== undefined ? { workingDirectory: URI.file(entry.cwd) } : {}),
					};
				});
		} catch (err) {
			this._logService.warn(`[DSH] listSessions failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	async getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		const sessionId = AgentSession.id(session);
		const all = await this.listSessions();
		const found = all.find(entry => AgentSession.id(entry.session) === sessionId);
		if (found && !this._sessions.has(sessionId)) {
			// Restore path: register a resumable entry so the next send
			// materializes through session/resume.
			this._sessions.set(sessionId, {
				sessionId,
				sessionUri: session,
				workingDirectory: found.workingDirectory,
				mapState: createDshSessionMapState(),
				pendingApprovals: new PendingRequestRegistry<boolean>(),
				materialized: false,
				needsResume: true,
				materializedEventFired: true,
			});
		}
		return found ? { ...found, session } : undefined;
	}

	async disposeSession(session: URI): Promise<void> {
		await this._closeBridgeSession(session);
		this._sessions.delete(AgentSession.id(session));
	}

	async releaseSession(session: URI): Promise<void> {
		// Non-destructive: free the bridge-side agent but keep the entry
		// resumable (the durable log survives in the harness home).
		await this._closeBridgeSession(session);
	}

	private async _closeBridgeSession(session: URI): Promise<void> {
		const entry = this._sessions.get(AgentSession.id(session));
		if (!entry) {
			return;
		}
		if (entry.materialized && this._connection.kind === 'ready') {
			try {
				await this._connection.client.request('session/close', { sessionId: entry.sessionId });
			} catch (err) {
				this._logService.warn(`[DSH:${entry.sessionId}] session/close failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		entry.materialized = false;
		entry.needsResume = true;
	}

	// #endregion

	// #region Active clients / server tools (not surfaced in v0)

	getOrCreateActiveClient(_session: URI, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		// Client-contributed tools and customizations are not part of bridge
		// protocol v0; accept and hold the contributions inertly.
		let tools: readonly ToolDefinition[] = [];
		let customizations: readonly ClientPluginCustomization[] = [];
		return {
			clientId: client.clientId,
			displayName: client.displayName,
			get tools() { return tools; },
			set tools(value: readonly ToolDefinition[]) { tools = value; },
			get customizations() { return customizations; },
			set customizations(value: readonly ClientPluginCustomization[]) { customizations = value; },
		};
	}

	removeActiveClient(_session: URI, _clientId: string): void { }

	onClientToolCallComplete(_session: URI, _chat: URI, toolCallId: string, _result: ToolCallResult): void {
		this._logService.info(`[DSH] unexpected client tool call completion for ${toolCallId} (no client tools in bridge protocol v0)`);
	}

	// #endregion

	async shutdown(): Promise<void> {
		if (this._connection.kind === 'ready') {
			const client = this._connection.client;
			try {
				// The bridge flushes persistence and exits 0 on shutdown.
				await client.request('shutdown');
			} catch (err) {
				this._logService.warn(`[DSH] shutdown request failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			client.dispose();
			this._connection = { kind: 'idle' };
		}
	}

	override dispose(): void {
		if (this._connection.kind === 'ready') {
			this._connection.client.dispose();
			this._connection = { kind: 'idle' };
		}
		super.dispose();
	}
}
