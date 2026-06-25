/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ProfileCardComponent } from './profileSelection.js';
import { IProfileCardData, ProfileId, PROFILE_STORAGE_KEY } from '../common/profileSelectionTypes.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { localize } from '../../../../nls.js';

const UXUI_PROFILE: IProfileCardData = {
	id: ProfileId.UXUI,
	codicon: 'symbol-color',
	title: localize('profile.uxui.title', "UX-UI Designer"),
	// allow-any-unicode-next-line
	description: localize('profile.uxui.description', "Focado em experiência do usuário e design de interfaces"),
	features: [
		localize('profile.uxui.feature1', "Prototipagem"),
		localize('profile.uxui.feature2', "Design Systems"),
		localize('profile.uxui.feature3', "Acessibilidade"),
		// allow-any-unicode-next-line
		localize('profile.uxui.feature4', "Pesquisa com usuários"),
	],
	tag: localize('profile.uxui.tag', "Design"),
};

const PO_PROFILE: IProfileCardData = {
	id: ProfileId.PO,
	codicon: 'project',
	title: localize('profile.po.title', "Product Owner"),
	// allow-any-unicode-next-line
	description: localize('profile.po.description', "Focado em gestão de produto e priorização de backlog"),
	features: [
		localize('profile.po.feature1', "Backlog"),
		localize('profile.po.feature2', "Roadmap"),
		// allow-any-unicode-next-line
		localize('profile.po.feature3', "Métricas"),
		localize('profile.po.feature4', "Stakeholders"),
	],
	tag: localize('profile.po.tag', "Produto"),
};

const ARQUITETO_PROFILE: IProfileCardData = {
	id: ProfileId.ARQUITETO,
	codicon: 'circuit-board',
	title: localize('profile.arquiteto.title', "Arquiteto"),
	// allow-any-unicode-next-line
	description: localize('profile.arquiteto.description', "Focado em arquitetura de sistemas e decisões técnicas"),
	features: [
		localize('profile.arquiteto.feature1', "Diagramas"),
		localize('profile.arquiteto.feature2', "Patterns"),
		localize('profile.arquiteto.feature3', "Code Review"),
		localize('profile.arquiteto.feature4', "RFC"),
	],
	tag: localize('profile.arquiteto.tag', "Arquitetura"),
};

const DEV_PROFILE: IProfileCardData = {
	id: ProfileId.DEV,
	codicon: 'code',
	title: localize('profile.dev.title', "Desenvolvedor"),
	// allow-any-unicode-next-line
	description: localize('profile.dev.description', "Focado em desenvolvimento e implementação de features"),
	features: [
		// allow-any-unicode-next-line
		localize('profile.dev.feature1', "Código"),
		localize('profile.dev.feature2', "Debug"),
		localize('profile.dev.feature3', "Testes"),
		localize('profile.dev.feature4', "CI/CD"),
	],
	tag: localize('profile.dev.tag', "Dev"),
};

const QA_PROFILE: IProfileCardData = {
	id: ProfileId.QA,
	codicon: 'beaker',
	title: localize('profile.qa.title', "QA Engineer"),
	// allow-any-unicode-next-line
	description: localize('profile.qa.description', "Focado em qualidade, testes e automação"),
	features: [
		localize('profile.qa.feature1', "Testes"),
		// allow-any-unicode-next-line
		localize('profile.qa.feature2', "Automação"),
		localize('profile.qa.feature3', "Bug Report"),
		localize('profile.qa.feature4', "Cobertura"),
	],
	tag: localize('profile.qa.tag', "QA"),
};

const ALL_PROFILES: readonly IProfileCardData[] = [UXUI_PROFILE, PO_PROFILE, ARQUITETO_PROFILE, DEV_PROFILE, QA_PROFILE];

// Prevents multiple simultaneous instances of the screen.
let _isScreenOpen = false;

export class ProfileSelectionScreen extends Disposable {

	private _overlay: HTMLElement | undefined;
	private readonly _cards = new Map<ProfileId, ProfileCardComponent>();

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	show(): void {
		if (_isScreenOpen || this._overlay) {
			return;
		}
		_isScreenOpen = true;

		const container = this.layoutService.mainContainer;

		this._overlay = append(container, $('.profile-selection-overlay'));
		this._overlay.setAttribute('role', 'dialog');
		this._overlay.setAttribute('aria-modal', 'true');
		this._overlay.setAttribute('aria-label', localize('profileSelection.aria', "Selecione seu perfil"));

		const dialog = append(this._overlay, $('.profile-selection-dialog'));

		const header = append(dialog, $('.profile-selection-header'));
		const title = append(header, $('h1.profile-selection-title'));
		title.textContent = localize('profileSelection.title', "Selecione seu perfil");
		const subtitle = append(header, $('p.profile-selection-subtitle'));
		// allow-any-unicode-next-line
		subtitle.textContent = localize('profileSelection.subtitle', "Escolha o perfil que melhor representa sua função para ter uma experiência personalizada.");

		const grid = append(dialog, $('.profile-selection-grid'));

		for (const profileData of ALL_PROFILES) {
			const card = this._register(new ProfileCardComponent(profileData));
			this._cards.set(profileData.id, card);
			grid.appendChild(card.element);
			this._register(card.onDidSelect(selectedId => {
				for (const [cardId, c] of this._cards) {
					c.setSelected(cardId === selectedId);
				}
				this._onProfileSelected(selectedId);
			}));
		}

		// Trap Tab/Shift+Tab at document level so no element needs initial focus.
		this._register(addDisposableListener(mainWindow.document, 'keydown', (e: KeyboardEvent) => {
			if (e.key !== 'Tab') {
				return;
			}
			const focusable = Array.from(this._cards.values()).map(c => c.element);
			if (focusable.length === 0) {
				return;
			}
			e.preventDefault();
			const currentIndex = focusable.indexOf(mainWindow.document.activeElement as HTMLElement);
			if (e.shiftKey) {
				const prev = currentIndex <= 0 ? focusable[focusable.length - 1] : focusable[currentIndex - 1];
				prev.focus();
			} else {
				const next = currentIndex < 0 || currentIndex >= focusable.length - 1 ? focusable[0] : focusable[currentIndex + 1];
				next.focus();
			}
		}));
	}

	private _onProfileSelected(id: ProfileId): void {
		this.storageService.store(PROFILE_STORAGE_KEY, id, StorageScope.APPLICATION, StorageTarget.USER);
		this.dispose();
	}

	private _hide(): void {
		_isScreenOpen = false;
		this._overlay?.remove();
		this._overlay = undefined;
		this._cards.clear();
	}

	override dispose(): void {
		this._hide();
		super.dispose();
	}
}
