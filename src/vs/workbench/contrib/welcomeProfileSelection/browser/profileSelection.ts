/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { $ } from '../../../../base/browser/dom.js';
import { IProfileCardData, ProfileId } from '../common/profileSelectionTypes.js';

export class ProfileCardComponent extends Disposable {

	private readonly _onDidSelect = this._register(new Emitter<ProfileId>());
	readonly onDidSelect: Event<ProfileId> = this._onDidSelect.event;

	private readonly _element: HTMLElement;
	private _selected: boolean = false;

	constructor(private readonly data: IProfileCardData) {
		super();
		this._element = this._build();
	}

	get element(): HTMLElement {
		return this._element;
	}

	setSelected(selected: boolean): void {
		this._selected = selected;
		this._element.classList.toggle('profile-card--selected', selected);
		this._element.setAttribute('aria-selected', String(selected));
	}

	private _build(): HTMLElement {
		const card = $('div.profile-card');
		card.setAttribute('role', 'option');
		card.setAttribute('aria-selected', 'false');
		card.setAttribute('tabindex', '0');

		const iconWrap = $('.profile-card__icon');
		const icon = $(`span.codicon.codicon-${this.data.codicon}`);
		iconWrap.appendChild(icon);

		const body = $('.profile-card__body');

		const title = $('h3.profile-card__title');
		title.textContent = this.data.title;

		const description = $('p.profile-card__description');
		description.textContent = this.data.description;

		const featureList = $('ul.profile-card__features');
		for (const feature of this.data.features) {
			const item = $('li.profile-card__feature');
			item.textContent = feature;
			featureList.appendChild(item);
		}

		const tag = $('span.profile-card__tag');
		tag.textContent = this.data.tag;

		body.appendChild(title);
		body.appendChild(description);
		body.appendChild(featureList);
		body.appendChild(tag);

		card.appendChild(iconWrap);
		card.appendChild(body);

		this._register({ dispose: () => { } });

		card.addEventListener('click', () => this._select());
		card.addEventListener('keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._select();
			}
		});

		return card;
	}

	private _select(): void {
		this.setSelected(true);
		this._onDidSelect.fire(this.data.id);
	}
}
