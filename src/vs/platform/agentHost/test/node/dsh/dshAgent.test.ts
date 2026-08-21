/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import type { INativeEnvironmentService } from '../../../../environment/common/environment.js';
import { AgentHostDshHarnessRootEnvVar, type AgentSignal } from '../../../common/agentService.js';
import { ActionType, type ChatAction, type SessionAction } from '../../../common/state/sessionActions.js';
import { DshAgent, dshHarnessBridgeEntry, isDshHarnessInstalled, resolveDshHarnessRoot } from '../../../node/dsh/dshAgent.js';

// The DSH provider registers by default, so a build (or dev checkout) with a
// missing or broken harness component must degrade gracefully: registration
// is skipped via `isDshHarnessInstalled`, and even a registered agent whose
// component disappears afterwards fails a send with a chat error instead of
// crashing the agent host.

suite('dshAgent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let tempDir: string;
	let savedOverride: string | undefined;

	setup(() => {
		tempDir = fs.mkdtempSync(join(os.tmpdir(), 'dsh-agent-test-'));
		savedOverride = process.env[AgentHostDshHarnessRootEnvVar];
	});

	teardown(() => {
		if (savedOverride === undefined) {
			delete process.env[AgentHostDshHarnessRootEnvVar];
		} else {
			process.env[AgentHostDshHarnessRootEnvVar] = savedOverride;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function makeAgent(harnessRoot: string): DshAgent {
		process.env[AgentHostDshHarnessRootEnvVar] = harnessRoot;
		const environmentService = { appRoot: join(tempDir, 'unused-app-root') } as INativeEnvironmentService;
		return store.add(new DshAgent(new NullLogService(), environmentService));
	}

	test('resolveDshHarnessRoot prefers the env override over the app root', () => {
		assert.strictEqual(resolveDshHarnessRoot({ [AgentHostDshHarnessRootEnvVar]: '/opt/harness' }, '/app'), '/opt/harness');
		assert.strictEqual(resolveDshHarnessRoot({}, '/app'), join('/app', 'devai-harness'));
		// An empty override does not shadow the shipped component.
		assert.strictEqual(resolveDshHarnessRoot({ [AgentHostDshHarnessRootEnvVar]: '' }, '/app'), join('/app', 'devai-harness'));
	});

	test('isDshHarnessInstalled requires the bridge entry to exist', () => {
		assert.strictEqual(isDshHarnessInstalled({}, tempDir), false, 'app root without the component must report not installed');
		const root = join(tempDir, 'harness');
		assert.strictEqual(isDshHarnessInstalled({ [AgentHostDshHarnessRootEnvVar]: root }, tempDir), false, 'override pointing at a missing dir must report not installed');
		fs.mkdirSync(join(root, 'src'), { recursive: true });
		fs.writeFileSync(dshHarnessBridgeEntry(root), '// placeholder bridge entry\n');
		assert.strictEqual(isDshHarnessInstalled({ [AgentHostDshHarnessRootEnvVar]: root }, tempDir), true);
	});

	test('sendMessage against a missing harness fails the turn with a chat error, without throwing', async () => {
		const missingRoot = join(tempDir, 'does-not-exist');
		const agent = makeAgent(missingRoot);

		const actions: (SessionAction | ChatAction)[] = [];
		store.add(agent.onDidSessionProgress((signal: AgentSignal) => {
			if (signal.kind === 'action') {
				actions.push(signal.action);
			}
		}));

		const created = await agent.createSession();
		assert.strictEqual(created.provisional, true, 'the session must stay provisional until the bridge materializes it');

		// The failure surfaces as a ChatError + ChatTurnComplete on the chat,
		// not as a rejected promise or an unhandled crash.
		await agent.chats.sendMessage(created.session, 'hello', undefined, undefined, 'turn-1');
		const error = actions.find(action => action.type === ActionType.ChatError);
		assert.ok(error, `expected a ChatError action, got: ${actions.map(action => action.type).join(', ')}`);
		assert.strictEqual((error as { error: { errorType: string } }).error.errorType, 'DshSendFailed');
		assert.ok((error as { error: { message: string } }).error.message.includes('DSH harness root not found'), 'the error must name the missing harness root');
		assert.ok(actions.some(action => action.type === ActionType.ChatTurnComplete), 'the failed turn must still complete');
	});

	test('listSessions against a missing harness resolves empty instead of throwing', async () => {
		const agent = makeAgent(join(tempDir, 'also-missing'));
		assert.deepStrictEqual(await agent.listSessions(), []);
	});
});
