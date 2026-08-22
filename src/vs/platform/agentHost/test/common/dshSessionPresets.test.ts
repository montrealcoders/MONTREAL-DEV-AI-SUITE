/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DSH_SELECTED_PROFILE_STORAGE_KEY, DSH_SESSION_PRESET_IDS, dshSessionPresetForProfile } from '../../common/dshSessionPresets.js';

suite('dshSessionPresets', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every DEV-AI Suite profile id maps onto itself as a preset', () => {
		// Mirror of the workbench ProfileId enum values (UXUI/PO/ARQUITETO/
		// DEV/QA) — platform cannot import the workbench enum, so this pins
		// the contract from this side; the workbench file documents the
		// inverse obligation next to the enum.
		const profileIds = ['uxui', 'po', 'arquiteto', 'dev', 'qa'];
		assert.deepStrictEqual([...DSH_SESSION_PRESET_IDS], profileIds);
		for (const id of profileIds) {
			assert.strictEqual(dshSessionPresetForProfile(id), id);
		}
	});

	test('anything that is not a known preset id maps to no preset', () => {
		for (const value of [undefined, null, '', 'UXUI', 'devops', 42, {}, ['dev']]) {
			assert.strictEqual(dshSessionPresetForProfile(value), undefined, `expected no preset for ${JSON.stringify(value)}`);
		}
	});

	test('the storage key matches the persisted profile-selection key', () => {
		assert.strictEqual(DSH_SELECTED_PROFILE_STORAGE_KEY, 'devai.selectedProfile');
	});
});
