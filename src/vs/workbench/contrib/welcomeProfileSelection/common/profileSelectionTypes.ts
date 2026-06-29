/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const enum ProfileId {
	UXUI = 'uxui',
	PO = 'po',
	ARQUITETO = 'arquiteto',
	DEV = 'dev',
	QA = 'qa'
}

export interface IProfileCardData {
	readonly id: ProfileId;
	readonly codicon: string;
	readonly title: string;
	readonly description: string;
	readonly features: readonly string[];
	readonly tag: string;
}

export const PROFILE_STORAGE_KEY = 'devai.selectedProfile';
