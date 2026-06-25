/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/profileSelection.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ProfileSelectionScreen } from './profileSelectionScreen.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { PROFILE_STORAGE_KEY } from '../common/profileSelectionTypes.js';
import { localize2 } from '../../../../nls.js';

registerAction2(class ShowProfileSelectionAction extends Action2 {
	constructor() {
		super({
			id: 'devai.showProfileSelection',
			title: localize2('showProfileSelection.title', 'Show Profile Selection'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const instantiationService = accessor.get(IInstantiationService);
		const screen = instantiationService.createInstance(ProfileSelectionScreen);
		screen.show();
	}
});

export class ProfileSelectionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.profileSelection';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._showIfNoProfileSelected();
	}

	private _showIfNoProfileSelected(): void {
		// TODO: Integrate with the custom Walkthrough (#95444 - Jorge).
		// Currently shows a temporary modal at IDE startup.
		// When the walkthrough is ready, profile selection should be
		// embedded in it and this modal should be removed.
		const stored = this.storageService.get(PROFILE_STORAGE_KEY, StorageScope.APPLICATION);
		if (!stored) {
			this._showScreen();
		}
	}

	private _showScreen(): void {
		const screen = this.instantiationService.createInstance(ProfileSelectionScreen);
		this._register(screen);
		screen.show();
	}
}

registerWorkbenchContribution2(
	ProfileSelectionContribution.ID,
	ProfileSelectionContribution,
	WorkbenchPhase.BlockRestore,
);
