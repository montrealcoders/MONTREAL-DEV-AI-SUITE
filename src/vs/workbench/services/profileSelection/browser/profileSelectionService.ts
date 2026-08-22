/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProfileSelectionService, ProfileId, PROFILE_STORAGE_KEY } from '../common/profileSelectionService.js';

const VALID_PROFILE_IDS = new Set<string>(Object.values(ProfileId));

export class ProfileSelectionService extends Disposable implements IProfileSelectionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProfile = this._register(new Emitter<ProfileId>());
	readonly onDidChangeProfile: Event<ProfileId> = this._onDidChangeProfile.event;

	private _currentProfile: ProfileId | undefined;

	get currentProfile(): ProfileId | undefined {
		return this._currentProfile;
	}

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ILogService logService: ILogService,
	) {
		super();
		const stored = storageService.get(PROFILE_STORAGE_KEY, StorageScope.APPLICATION);
		if (stored && !VALID_PROFILE_IDS.has(stored)) {
			logService.warn(`[ProfileSelectionService] Invalid profile value in storage: "${stored}". Resetting to undefined.`);
		}
		this._currentProfile = stored && VALID_PROFILE_IDS.has(stored) ? stored as ProfileId : undefined;
	}

	setProfile(id: ProfileId): void {
		if (this._currentProfile === id) {
			return;
		}
		this._currentProfile = id;
		this.storageService.store(PROFILE_STORAGE_KEY, id, StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChangeProfile.fire(id);
	}
}

registerSingleton(IProfileSelectionService, ProfileSelectionService, InstantiationType.Delayed);
