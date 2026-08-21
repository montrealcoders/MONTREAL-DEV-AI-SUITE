/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { migrateThemeSettingsId, ThemeSettingDefaults } from '../../common/workbenchThemeService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('WorkbenchThemeService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('migrateThemeSettingsId', () => {

		test('migrates Default-prefixed theme IDs', () => {
			assert.deepStrictEqual(
				['Default Dark Modern', 'Default Light Modern', 'Default Dark+', 'Default Light+'].map(migrateThemeSettingsId),
				['Dark Modern', 'Light Modern', 'Dark+', 'Light+']
			);
		});

		test('migrates Experimental theme IDs to VS Code themes', () => {
			assert.deepStrictEqual(
				['Experimental Dark', 'Experimental Light', 'VS Code Dark', 'VS Code Light'].map(migrateThemeSettingsId),
				[ThemeSettingDefaults.COLOR_THEME_DARK, ThemeSettingDefaults.COLOR_THEME_LIGHT, ThemeSettingDefaults.COLOR_THEME_DARK, ThemeSettingDefaults.COLOR_THEME_LIGHT]
			);
		});

		test('migrates the previous default dark theme to the product default', () => {
			assert.deepStrictEqual(
				['Dark 2026'].map(migrateThemeSettingsId),
				[ThemeSettingDefaults.COLOR_THEME_DARK]
			);
		});

		test('returns unknown IDs unchanged', () => {
			assert.deepStrictEqual(
				['Dark Modern', 'Monokai', 'Some Custom Theme', ''].map(migrateThemeSettingsId),
				['Dark Modern', 'Monokai', 'Some Custom Theme', '']
			);
		});
	});
});
