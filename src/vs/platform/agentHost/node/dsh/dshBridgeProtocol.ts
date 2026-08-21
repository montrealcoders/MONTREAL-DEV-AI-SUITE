/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Bridge protocol v0 — the Montreal-owned wire contract between the agent
// host's DshAgent and the embedded DSH runtime's `devai-bridge` plugin
// (`devai-harness/bridge/README.md` is the normative document). JSON-RPC 2.0
// over newline-delimited JSON on the bridge child process's stdio.
//
// The protocol version and the dsh runtime pin move together: v0 is
// contracted against DeepSeek Harness v0.1.1-rc.2, and the session event
// vocabulary below mirrors that pin's `SessionEventMap`. Only the event
// types this client actually maps are typed; everything else flows through
// as `IDshSessionEvent` with unknown `data` and is ignored by the mapper.

/** The bridge protocol version this client speaks. */
export const DSH_BRIDGE_PROTOCOL_VERSION = 0;

/** The exact dsh runtime pin bridge protocol v0 is contracted against. */
export const DSH_BRIDGE_RUNTIME_PIN = '0.1.1-rc.2';

// #region Client -> server methods

export interface IDshInitializeResult {
	readonly protocol: { readonly name: string; readonly version: number };
	readonly runtime: { readonly name: string; readonly pin: string };
	readonly providers: readonly { readonly id: string; readonly name: string }[];
}

export interface IDshSessionCreateParams {
	readonly sessionId?: string;
	readonly cwd?: string;
	readonly provider?: string;
	readonly model?: string;
}

export interface IDshSessionCreateResult {
	readonly sessionId: string;
}

export interface IDshSessionListEntry {
	readonly sessionId: string;
	/** Unix epoch milliseconds. */
	readonly createdAt: number;
	readonly cwd?: string;
	readonly parentSession?: string;
	/** Whether the session is currently live in the runtime's agent registry. */
	readonly live: boolean;
}

export interface IDshSessionListResult {
	readonly sessions: readonly IDshSessionListEntry[];
}

export interface IDshSessionResumeParams {
	readonly sessionId: string;
}

export interface IDshSessionResumeResult {
	readonly sessionId: string;
	/** The full replayed session event log, in seq order. */
	readonly events: readonly IDshSessionEvent[];
}

export interface IDshSessionPromptParams {
	readonly sessionId: string;
	/** A plain string (one text block) or an array of dsh content blocks. */
	readonly content: string | readonly Record<string, unknown>[];
}

export interface IDshSessionPromptResult {
	readonly messageId: string;
}

export interface IDshSessionRefParams {
	readonly sessionId: string;
}

// #endregion

// #region Server -> client traffic

/** Params of the `session/event` notification. */
export interface IDshSessionEventNotification {
	readonly sessionId: string;
	readonly event: IDshSessionEvent;
}

/** Params of the `session/status` notification. */
export interface IDshSessionStatusNotification {
	readonly sessionId: string;
	readonly status: 'idle' | 'running';
}

/** Params of the server->client `approval/request` request. */
export interface IDshApprovalRequestParams {
	readonly requestId: string;
	readonly sessionId: string;
	readonly toolName: string;
	/** The exact tool call being decided, when the runtime has one. */
	readonly callId?: string;
	readonly reason?: string;
}

/** Outcome vocabulary of the dsh approval seam (fail-closed). */
export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** Expected result of the `approval/request` server->client request. */
export interface IDshApprovalResponse {
	readonly outcome: DshApprovalOutcome;
}

// #endregion

// #region dsh session events (pinned vocabulary subset)

/** One durable dsh session event, exactly as appended to the session log. */
export interface IDshSessionEvent {
	readonly type: string;
	/** Monotonic sequence number within the session. */
	readonly seq: number;
	/** Unix epoch milliseconds. */
	readonly time: number;
	readonly data: unknown;
}

/** One dsh content block (text is the only shape this client interprets). */
export interface IDshContentBlock {
	readonly type: string;
	readonly text?: string;
}

/** `user/message` / the message inside `assistant/message`. */
export interface IDshMessage {
	readonly id: string;
	readonly role: string;
	readonly content: readonly IDshContentBlock[];
	readonly source?: { readonly kind?: string };
}

export interface IDshTurnStartData {
	readonly turn: number;
}

export interface IDshTurnEndData {
	readonly turn: number;
	readonly reason: { readonly kind: string; readonly error?: { readonly message?: string; readonly code?: string } };
}

/** Raw provider stream chunk carried by `assistant/chunk`. */
export interface IDshStreamChunk {
	readonly type: string;
	readonly index?: number;
	readonly text?: string;
}

export interface IDshAssistantChunkData {
	readonly turn: number;
	readonly step: number;
	readonly chunk: IDshStreamChunk;
}

export interface IDshAssistantMessageData {
	readonly turn: number;
	readonly step: number;
	readonly message: IDshMessage;
	readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
	readonly interrupted?: true;
}

export interface IDshToolCallData {
	readonly turn: number;
	readonly step: number;
	readonly callId: string;
	readonly name: string;
	/** Raw arguments JSON string, exactly as the model produced it. */
	readonly arguments: string;
}

export interface IDshToolResultData {
	readonly turn: number;
	readonly step: number;
	readonly message: {
		readonly content: readonly {
			readonly type: string;
			readonly toolCallId?: string;
			readonly isError?: boolean;
			readonly content?: readonly IDshContentBlock[];
		}[];
	};
}

export interface IDshSessionTitleData {
	readonly title: string;
}

// #endregion
