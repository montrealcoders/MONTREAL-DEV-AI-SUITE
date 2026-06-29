/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProfileId } from '../../../services/profileSelection/common/profileSelectionService.js';

export { ProfileId };

export interface IProfileCardData {
	readonly id: ProfileId;
	readonly codicon: string;
	readonly title: string;
	readonly description: string;
	readonly features: readonly string[];
	readonly tag: string;
}
