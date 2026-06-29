/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export enum ProfileId {
	UXUI = 'uxui',
	PO = 'po',
	ARQUITETO = 'arquiteto',
	DEV = 'dev',
	QA = 'qa'
}

export const PROFILE_STORAGE_KEY = 'devai.selectedProfile';

export const IProfileSelectionService = createDecorator<IProfileSelectionService>('profileSelectionService');

export interface IProfileSelectionService {
	readonly _serviceBrand: undefined;
	readonly currentProfile: ProfileId | undefined;
	readonly onDidChangeProfile: Event<ProfileId>;
	setProfile(id: ProfileId): void;
}
