/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import { MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type ToolCallCompletedState, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import type { IDshAssistantChunkData, IDshAssistantMessageData, IDshMessage, IDshSessionEvent, IDshSessionTitleData, IDshToolCallData, IDshToolResultData, IDshTurnEndData } from './dshBridgeProtocol.js';

// Maps the pinned dsh session-event vocabulary (bridge protocol v0,
// `dshBridgeProtocol.ts`) onto agent host protocol actions. Mirrors the role
// `codexMapAppServerEvents.ts` plays for the codex item stream: pure
// functions over a small per-session mutable map state, so `DshAgent` stays
// a thin router and the mapping is unit-testable without a runtime.
//
// dsh streams durable session events: `turn/start` .. (`assistant/chunk`*,
// `assistant/message`, `tool/call`, `tool/result`)* .. `turn/end`. Text
// streams as `text-delta` chunks indexed by content block; each open block
// becomes one markdown (or reasoning) response part fed by `ChatDelta` /
// `ChatReasoning`. Log-only audit events (`approval/*`, `step/*`, inbox and
// request records) map to no action — approvals surface through the bridge's
// `approval/request` server request instead (see `DshAgent`).

/** Per-session mutable state the mapper threads between events. */
export interface IDshSessionMapState {
	/** Host turn id of the open turn; set by sendMessage, minted on replayed/injected turns. */
	currentTurnId: string | undefined;
	/** Prompt text buffered by sendMessage for `turn/start`'s message. */
	lastPromptText: string;
	/** `time` of the open turn's `turn/start`, for producer-clock durations. */
	turnStartedAtMs: number | undefined;
	/** Markdown part id per open stream block, keyed `step:index`. */
	readonly partIdByBlock: Map<string, string>;
	/** Reasoning part id per open stream block, keyed `step:index`. */
	readonly reasoningPartIdByBlock: Map<string, string>;
	/** Steps that streamed at least one text delta (their `assistant/message` adds no duplicate part). */
	readonly streamedTextSteps: Set<number>;
	/** Open tool calls of the current turn: callId -> tool name. */
	readonly openToolCalls: Map<string, string>;
}

export function createDshSessionMapState(): IDshSessionMapState {
	return {
		currentTurnId: undefined,
		lastPromptText: '',
		turnStartedAtMs: undefined,
		partIdByBlock: new Map(),
		reasoningPartIdByBlock: new Map(),
		streamedTextSteps: new Set(),
		openToolCalls: new Map(),
	};
}

/** Concatenate the text blocks of a dsh message. */
export function dshMessageText(message: IDshMessage | undefined): string {
	if (!message || !Array.isArray(message.content)) {
		return '';
	}
	return message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
}

/** Extract the model-facing text and error flag of a `tool/result` event. */
export function dshToolResultText(data: IDshToolResultData): { text: string; isError: boolean } {
	const block = data.message?.content?.find(entry => entry.type === 'tool-result');
	if (!block) {
		return { text: '', isError: false };
	}
	const text = (block.content ?? []).filter(inner => inner.type === 'text' && typeof inner.text === 'string').map(inner => inner.text).join('');
	return { text, isError: block.isError === true };
}

function ensureTurnId(state: IDshSessionMapState): string {
	state.currentTurnId ??= generateUuid();
	return state.currentTurnId;
}

function resetTurnState(state: IDshSessionMapState): void {
	state.partIdByBlock.clear();
	state.reasoningPartIdByBlock.clear();
	state.streamedTextSteps.clear();
	state.openToolCalls.clear();
	state.currentTurnId = undefined;
	state.turnStartedAtMs = undefined;
}

/**
 * Map one durable dsh session event onto protocol actions. Events outside
 * the mapped vocabulary (audit records, step boundaries, plugin extensions)
 * produce no action.
 */
export function mapDshSessionEvent(state: IDshSessionMapState, event: IDshSessionEvent): (SessionAction | ChatAction)[] {
	switch (event.type) {
		case 'turn/start': {
			state.turnStartedAtMs = event.time;
			const turnId = ensureTurnId(state);
			return [{
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date(event.time).toISOString(),
				message: { text: state.lastPromptText, origin: { kind: MessageKind.User } },
			}];
		}
		case 'assistant/chunk': {
			const data = event.data as IDshAssistantChunkData;
			const chunk = data.chunk;
			const turnId = ensureTurnId(state);
			if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
				state.streamedTextSteps.add(data.step);
				const key = `${data.step}:${chunk.index ?? 0}`;
				const actions: (SessionAction | ChatAction)[] = [];
				let partId = state.partIdByBlock.get(key);
				if (partId === undefined) {
					partId = generateUuid();
					state.partIdByBlock.set(key, partId);
					actions.push({ type: ActionType.ChatResponsePart, turnId, part: { kind: ResponsePartKind.Markdown, id: partId, content: '' } });
				}
				actions.push({ type: ActionType.ChatDelta, turnId, partId, content: chunk.text });
				return actions;
			}
			if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
				const key = `${data.step}:${chunk.index ?? 0}`;
				const actions: (SessionAction | ChatAction)[] = [];
				let partId = state.reasoningPartIdByBlock.get(key);
				if (partId === undefined) {
					partId = generateUuid();
					state.reasoningPartIdByBlock.set(key, partId);
					actions.push({ type: ActionType.ChatResponsePart, turnId, part: { kind: ResponsePartKind.Reasoning, id: partId, content: '' } });
				}
				actions.push({ type: ActionType.ChatReasoning, turnId, partId, content: chunk.text });
				return actions;
			}
			return [];
		}
		case 'assistant/message': {
			const data = event.data as IDshAssistantMessageData;
			const turnId = ensureTurnId(state);
			const actions: (SessionAction | ChatAction)[] = [];
			// A step whose text never streamed (chunk replay disabled, or a
			// non-streaming adapter) still renders its assembled message.
			const text = dshMessageText(data.message);
			if (text.length > 0 && !state.streamedTextSteps.has(data.step)) {
				actions.push({ type: ActionType.ChatResponsePart, turnId, part: { kind: ResponsePartKind.Markdown, id: generateUuid(), content: text } });
			}
			if (data.usage !== undefined) {
				actions.push({ type: ActionType.ChatUsage, turnId, usage: { inputTokens: data.usage.inputTokens, outputTokens: data.usage.outputTokens } });
			}
			return actions;
		}
		case 'tool/call': {
			const data = event.data as IDshToolCallData;
			const turnId = ensureTurnId(state);
			state.openToolCalls.set(data.callId, data.name);
			return [
				{ type: ActionType.ChatToolCallStart, turnId, toolCallId: data.callId, toolName: data.name, displayName: data.name },
				{ type: ActionType.ChatToolCallDelta, turnId, toolCallId: data.callId, content: data.arguments },
				// The runtime owns approval policy: the call runs unless the
				// approval seam interjects, in which case the bridge's
				// `approval/request` re-fires a Ready without `confirmed`
				// (mid-execution re-confirmation, handled in DshAgent).
				{ type: ActionType.ChatToolCallReady, turnId, toolCallId: data.callId, invocationMessage: data.name, toolInput: data.arguments, confirmed: ToolCallConfirmationReason.NotNeeded },
			];
		}
		case 'tool/result': {
			const data = event.data as IDshToolResultData;
			const turnId = ensureTurnId(state);
			const block = data.message?.content?.find(entry => entry.type === 'tool-result');
			const callId = block?.toolCallId;
			if (callId === undefined) {
				return [];
			}
			const name = state.openToolCalls.get(callId) ?? 'tool';
			state.openToolCalls.delete(callId);
			const { text, isError } = dshToolResultText(data);
			return [{
				type: ActionType.ChatToolCallComplete,
				turnId,
				toolCallId: callId,
				result: {
					success: !isError,
					pastTenseMessage: isError ? `${name} failed` : `Ran ${name}`,
					...(text.length > 0 ? { content: [{ type: ToolResultContentType.Text as const, text }] } : {}),
					...(isError ? { error: { message: text || `${name} failed` } } : {}),
				},
			}];
		}
		case 'turn/end': {
			const data = event.data as IDshTurnEndData;
			const turnId = ensureTurnId(state);
			const duration = state.turnStartedAtMs === undefined ? 0 : Math.max(0, event.time - state.turnStartedAtMs);
			const actions: (SessionAction | ChatAction)[] = [];
			const kind = data.reason?.kind;
			if (kind === 'cancelled') {
				actions.push({ type: ActionType.ChatTurnCancelled, turnId, duration });
			} else {
				if (kind === 'error') {
					actions.push({
						type: ActionType.ChatError,
						turnId,
						duration,
						error: { errorType: 'DshTurnError', message: data.reason.error?.message ?? 'DSH turn failed' },
					});
				}
				actions.push({ type: ActionType.ChatTurnComplete, turnId, duration });
			}
			resetTurnState(state);
			return actions;
		}
		case 'session/title': {
			const data = event.data as IDshSessionTitleData;
			return typeof data.title === 'string' && data.title.length > 0
				? [{ type: ActionType.SessionTitleChanged, title: data.title }]
				: [];
		}
		default:
			// Log-only or unmapped vocabulary (step boundaries, approval and
			// inbox audit, request headers, plugin extensions).
			return [];
	}
}

/**
 * Reconstruct protocol {@link Turn}s from a persisted dsh session event log
 * (the `session/resume` payload), for session restore. The counterpart of
 * `codexReplayMapper.ts`: replay is derived from the same durable events the
 * live path maps, so restored history matches what streamed.
 */
export function replayDshEventsToTurns(events: readonly IDshSessionEvent[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | undefined;
	let sawUserMessage = false;
	const openToolCalls = new Map<string, { name: string; args: string; part: { kind: ResponsePartKind.ToolCall; toolCall: ToolCallCompletedState } }>();

	const completedToolCall = (callId: string, name: string, args: string, result: ToolCallResult): ToolCallCompletedState => ({
		status: ToolCallStatus.Completed,
		toolCallId: callId,
		toolName: name,
		displayName: name,
		invocationMessage: name,
		toolInput: args,
		confirmed: ToolCallConfirmationReason.NotNeeded,
		...result,
	});

	const closeTurn = (state: TurnState, endTime: number | undefined, error?: { message: string }): void => {
		if (!current) {
			return;
		}
		// A call the log never answered surfaces as a failed completion so the
		// transcript stays coherent (persistence repair appends synthetic
		// closers, so this is a defensive fallback).
		for (const [callId, open] of openToolCalls) {
			open.part.toolCall = completedToolCall(callId, open.name, open.args, {
				success: false,
				pastTenseMessage: `Stopped ${open.name}`,
				error: { message: 'The turn ended before the tool reported completion' },
			});
		}
		openToolCalls.clear();
		if (endTime !== undefined && current.startedAt !== undefined) {
			current.duration = Math.max(0, endTime - Date.parse(current.startedAt));
		}
		current.state = state;
		if (error) {
			current.error = { errorType: 'DshTurnError', message: error.message };
		}
		turns.push(current);
		current = undefined;
	};

	for (const event of events) {
		switch (event.type) {
			case 'turn/start': {
				closeTurn(TurnState.Complete, undefined);
				sawUserMessage = false;
				current = {
					id: generateUuid(),
					startedAt: new Date(event.time).toISOString(),
					message: { text: '', origin: { kind: MessageKind.User } },
					responseParts: [],
					usage: undefined,
					state: TurnState.Complete,
				};
				break;
			}
			case 'user/message': {
				// The first direct user message of the turn is its prompt;
				// injected context (system reminders, runtime snapshots) is not.
				const message = event.data as IDshMessage;
				if (current && !sawUserMessage && message.source?.kind === 'user') {
					sawUserMessage = true;
					current.message = { text: dshMessageText(message), origin: { kind: MessageKind.User } };
				}
				break;
			}
			case 'assistant/message': {
				const data = event.data as IDshAssistantMessageData;
				const text = dshMessageText(data.message);
				if (current && text.length > 0) {
					current.responseParts.push({ kind: ResponsePartKind.Markdown, id: generateUuid(), content: text });
				}
				if (current && data.usage !== undefined) {
					current.usage = { inputTokens: data.usage.inputTokens, outputTokens: data.usage.outputTokens };
				}
				break;
			}
			case 'tool/call': {
				const data = event.data as IDshToolCallData;
				if (!current) {
					break;
				}
				const part: { kind: ResponsePartKind.ToolCall; toolCall: ToolCallCompletedState } = {
					kind: ResponsePartKind.ToolCall,
					toolCall: completedToolCall(data.callId, data.name, data.arguments, {
						success: false,
						pastTenseMessage: `Ran ${data.name}`,
					}),
				};
				openToolCalls.set(data.callId, { name: data.name, args: data.arguments, part });
				current.responseParts.push(part);
				break;
			}
			case 'tool/result': {
				const data = event.data as IDshToolResultData;
				const block = data.message?.content?.find(entry => entry.type === 'tool-result');
				const open = block?.toolCallId !== undefined ? openToolCalls.get(block.toolCallId) : undefined;
				if (!open) {
					break;
				}
				const callId = block!.toolCallId!;
				openToolCalls.delete(callId);
				const { text, isError } = dshToolResultText(data);
				open.part.toolCall = completedToolCall(callId, open.name, open.args, {
					success: !isError,
					pastTenseMessage: isError ? `${open.name} failed` : `Ran ${open.name}`,
					...(text.length > 0 ? { content: [{ type: ToolResultContentType.Text as const, text }] } : {}),
					...(isError ? { error: { message: text || `${open.name} failed` } } : {}),
				});
				break;
			}
			case 'turn/end': {
				const data = event.data as IDshTurnEndData;
				const kind = data.reason?.kind;
				if (kind === 'cancelled') {
					closeTurn(TurnState.Cancelled, event.time);
				} else if (kind === 'error') {
					closeTurn(TurnState.Error, event.time, { message: data.reason.error?.message ?? 'DSH turn failed' });
				} else {
					closeTurn(TurnState.Complete, event.time);
				}
				break;
			}
			default:
				break;
		}
	}
	// Persistence repair closes interrupted turns durably, so an open turn
	// here means a live log snapshot; surface what streamed so far.
	closeTurn(TurnState.Complete, undefined);
	return turns;
}
