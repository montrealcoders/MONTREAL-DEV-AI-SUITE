/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ActionType, type ChatAction, type SessionAction } from '../../../common/state/sessionActions.js';
import { ResponsePartKind, ToolCallStatus, TurnState } from '../../../common/state/sessionState.js';
import type { IDshSessionEvent } from '../../../node/dsh/dshBridgeProtocol.js';
import { createDshSessionMapState, mapDshSessionEvent, replayDshEventsToTurns } from '../../../node/dsh/dshEventMapper.js';

// The fixture log mirrors a real bridge run of the devai-harness contract
// test (devai-harness/test/bridge-protocol.test.ts): one turn whose model
// step calls the approval-gated probe tool, then a second step that streams
// the closing text.

function fixtureEvents(): IDshSessionEvent[] {
	let seq = 0;
	const at = (offsetMs: number) => 1_000_000 + offsetMs;
	const event = (type: string, data: unknown, offsetMs: number): IDshSessionEvent => ({ type, seq: seq++, time: at(offsetMs), data });
	return [
		event('turn/start', { turn: 1 }, 0),
		event('user/message', { id: 'm-1', role: 'user', content: [{ type: 'text', text: 'Run the probe.' }], source: { kind: 'user' } }, 1),
		event('user/message', { id: 'm-2', role: 'user', content: [{ type: 'text', text: '<system-reminder>injected context</system-reminder>' }], source: { kind: 'context' } }, 2),
		event('step/start', { turn: 1, step: 1 }, 3),
		event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'bridge_probe', argumentsDelta: '{"label":"e2e"}' } }, 4),
		event('assistant/message', { turn: 1, step: 1, message: { id: 'a-1', role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'bridge_probe' }] }, usage: { inputTokens: 10, outputTokens: 5 } }, 5),
		event('tool/call', { turn: 1, step: 1, callId: 'call_1', name: 'bridge_probe', arguments: '{"label":"e2e"}' }, 6),
		event('approval/asked', { id: 'ap-1', toolName: 'bridge_probe', callId: 'call_1', reason: 'bridge approval probe' }, 7),
		event('approval/decided', { id: 'ap-1', outcome: 'allowed-once' }, 8),
		event('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: 'probe:e2e' }] }] } }, 9),
		event('step/end', { turn: 1, step: 1 }, 10),
		event('step/start', { turn: 1, step: 2 }, 11),
		event('assistant/chunk', { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'do' } }, 12),
		event('assistant/chunk', { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'ne' } }, 13),
		event('assistant/message', { turn: 1, step: 2, message: { id: 'a-2', role: 'assistant', content: [{ type: 'text', text: 'done' }] }, usage: { inputTokens: 12, outputTokens: 1 } }, 14),
		event('step/end', { turn: 1, step: 2 }, 15),
		event('session/title', { title: 'Probe Session' }, 16),
		event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 17),
	];
}

function mapAll(events: readonly IDshSessionEvent[]): (SessionAction | ChatAction)[] {
	const state = createDshSessionMapState();
	state.currentTurnId = 'turn-host-1';
	state.lastPromptText = 'Run the probe.';
	return events.flatMap(event => mapDshSessionEvent(state, event));
}

suite('dshEventMapper', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps a full probe turn onto ordered protocol actions', () => {
		const actions = mapAll(fixtureEvents());
		const types = actions.map(action => action.type);

		assert.deepStrictEqual(types, [
			ActionType.ChatTurnStarted,
			ActionType.ChatUsage,               // step 1 assistant/message (tool call only, no text part)
			ActionType.ChatToolCallStart,
			ActionType.ChatToolCallDelta,
			ActionType.ChatToolCallReady,
			ActionType.ChatToolCallComplete,
			ActionType.ChatResponsePart,        // step 2 first text-delta opens the markdown part
			ActionType.ChatDelta,
			ActionType.ChatDelta,
			ActionType.ChatUsage,               // step 2 usage (text already streamed, no duplicate part)
			ActionType.SessionTitleChanged,
			ActionType.ChatTurnComplete,
		]);

		const started = actions[0] as Extract<ChatAction, { type: ActionType.ChatTurnStarted }>;
		assert.strictEqual(started.turnId, 'turn-host-1');
		assert.strictEqual(started.message.text, 'Run the probe.');

		const toolStart = actions[2] as Extract<ChatAction, { type: ActionType.ChatToolCallStart }>;
		assert.strictEqual(toolStart.toolCallId, 'call_1');
		assert.strictEqual(toolStart.toolName, 'bridge_probe');

		const toolComplete = actions[5] as Extract<ChatAction, { type: ActionType.ChatToolCallComplete }>;
		assert.strictEqual(toolComplete.result.success, true);
		assert.strictEqual(toolComplete.result.content?.[0].type, 'text');

		const deltas = actions.filter((action): action is Extract<ChatAction, { type: ActionType.ChatDelta }> => action.type === ActionType.ChatDelta);
		assert.strictEqual(deltas.map(delta => delta.content).join(''), 'done');
		const part = actions[6] as Extract<ChatAction, { type: ActionType.ChatResponsePart }>;
		assert.strictEqual(part.part.kind, ResponsePartKind.Markdown);
		assert.strictEqual(deltas[0].partId, part.part.id);

		const title = actions[10] as Extract<SessionAction, { type: ActionType.SessionTitleChanged }>;
		assert.strictEqual(title.title, 'Probe Session');

		const complete = actions[11] as Extract<ChatAction, { type: ActionType.ChatTurnComplete }>;
		assert.strictEqual(complete.turnId, 'turn-host-1');
		assert.strictEqual(complete.duration, 17);
	});

	test('an error turn maps to ChatError followed by ChatTurnComplete', () => {
		const state = createDshSessionMapState();
		state.currentTurnId = 'turn-err';
		const actions = [
			...mapDshSessionEvent(state, { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } }),
			...mapDshSessionEvent(state, { type: 'turn/end', seq: 1, time: 150, data: { turn: 1, reason: { kind: 'error', error: { message: 'no provider' } } } }),
		];
		assert.deepStrictEqual(actions.map(action => action.type), [ActionType.ChatTurnStarted, ActionType.ChatError, ActionType.ChatTurnComplete]);
		const error = actions[1] as Extract<ChatAction, { type: ActionType.ChatError }>;
		assert.strictEqual(error.error.message, 'no provider');
		assert.strictEqual(error.duration, 50);
	});

	test('a cancelled turn maps to ChatTurnCancelled and resets the turn id', () => {
		const state = createDshSessionMapState();
		state.currentTurnId = 'turn-c';
		mapDshSessionEvent(state, { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } });
		const actions = mapDshSessionEvent(state, { type: 'turn/end', seq: 1, time: 130, data: { turn: 1, reason: { kind: 'cancelled', cause: { kind: 'user' } } } });
		assert.deepStrictEqual(actions.map(action => action.type), [ActionType.ChatTurnCancelled]);
		assert.strictEqual(state.currentTurnId, undefined);
	});

	test('a non-streamed assistant message still renders one markdown part', () => {
		const state = createDshSessionMapState();
		state.currentTurnId = 'turn-ns';
		mapDshSessionEvent(state, { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } });
		const actions = mapDshSessionEvent(state, {
			type: 'assistant/message', seq: 1, time: 110,
			data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'assembled only' }] } },
		});
		assert.deepStrictEqual(actions.map(action => action.type), [ActionType.ChatResponsePart]);
		const part = actions[0] as Extract<ChatAction, { type: ActionType.ChatResponsePart }>;
		assert.strictEqual(part.part.kind === ResponsePartKind.Markdown ? part.part.content : '', 'assembled only');
	});

	test('unmapped vocabulary produces no actions', () => {
		const state = createDshSessionMapState();
		for (const type of ['step/start', 'step/end', 'approval/asked', 'approval/decided', 'request/header', 'agent/inbox/spliced', 'sandbox/mode']) {
			assert.deepStrictEqual(mapDshSessionEvent(state, { type, seq: 0, time: 1, data: {} }), [], `expected no actions for ${type}`);
		}
	});

	test('replay reconstructs the turn with prompt, tool call, text, usage, and state', () => {
		const turns = replayDshEventsToTurns(fixtureEvents());
		assert.strictEqual(turns.length, 1);
		const turn = turns[0];
		assert.strictEqual(turn.message.text, 'Run the probe.');
		assert.strictEqual(turn.state, TurnState.Complete);
		assert.strictEqual(turn.duration, 17);
		assert.deepStrictEqual(turn.usage, { inputTokens: 12, outputTokens: 1 });

		assert.strictEqual(turn.responseParts.length, 2);
		const toolPart = turn.responseParts[0];
		assert.strictEqual(toolPart.kind, ResponsePartKind.ToolCall);
		if (toolPart.kind === ResponsePartKind.ToolCall) {
			assert.strictEqual(toolPart.toolCall.status, ToolCallStatus.Completed);
			assert.strictEqual(toolPart.toolCall.toolName, 'bridge_probe');
			if (toolPart.toolCall.status === ToolCallStatus.Completed) {
				assert.strictEqual(toolPart.toolCall.success, true);
			}
		}
		const textPart = turn.responseParts[1];
		assert.strictEqual(textPart.kind === ResponsePartKind.Markdown ? textPart.content : '', 'done');
	});

	test('replay closes a call the log never answered as a failed completion', () => {
		const events: IDshSessionEvent[] = [
			{ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
			{ type: 'user/message', seq: 1, time: 101, data: { id: 'm', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } } },
			{ type: 'tool/call', seq: 2, time: 102, data: { turn: 1, step: 1, callId: 'call_x', name: 'bridge_probe', arguments: '{}' } },
			{ type: 'turn/end', seq: 3, time: 103, data: { turn: 1, reason: { kind: 'cancelled', cause: { kind: 'user' } } } },
		];
		const turns = replayDshEventsToTurns(events);
		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].state, TurnState.Cancelled);
		const toolPart = turns[0].responseParts[0];
		assert.strictEqual(toolPart.kind, ResponsePartKind.ToolCall);
		if (toolPart.kind === ResponsePartKind.ToolCall && toolPart.toolCall.status === ToolCallStatus.Completed) {
			assert.strictEqual(toolPart.toolCall.success, false);
		} else {
			assert.fail('expected a completed (failed) tool call');
		}
	});
});
