/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { DSH_SELECTED_PROFILE_STORAGE_KEY } from '../../../../platform/agentHost/common/dshSessionPresets.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export enum ProfileId {
	UXUI = 'uxui',
	PO = 'po',
	ARQUITETO = 'arquiteto',
	DEV = 'dev',
	QA = 'qa'
}

/**
 * Storage key of the selected profile. The constant itself lives in platform
 * (`dshSessionPresets.ts`) because the platform agent-host clients read the
 * same key to forward the selection to the agent host, where DSH sessions map
 * it onto a preset — and platform cannot import workbench code. Every
 * `ProfileId` value must have a matching entry in `DSH_SESSION_PRESET_IDS`.
 */
export const PROFILE_STORAGE_KEY = DSH_SELECTED_PROFILE_STORAGE_KEY;

export const IProfileSelectionService = createDecorator<IProfileSelectionService>('profileSelectionService');

export interface IProfileSelectionService {
	readonly _serviceBrand: undefined;
	readonly currentProfile: ProfileId | undefined;
	readonly onDidChangeProfile: Event<ProfileId>;
	setProfile(id: ProfileId): void;
}
