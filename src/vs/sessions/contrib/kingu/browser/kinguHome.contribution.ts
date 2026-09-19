/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguHome.css';
import { $ } from '../../../../base/browser/dom.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';

export const KINGU_HOME_VIEW_ID = 'kingu.customView.home';

interface IKinguCapability {
	readonly name: string;
	readonly detail: string;
}

/**
 * First Kingu-owned surface in the Agents Window. It currently states what the
 * shell provides; the fleet/worktree surface ported from the ADE replaces the body.
 */
class KinguHomeView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('kingu.home.title', "Kingu"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('kingu.home.description', "One shell for agents and code, on a shared AI core."));

	private static readonly CAPABILITIES: IKinguCapability[] = [
		{
			name: localize('kingu.home.card.modes.name', "Two modes, one app"),
			detail: localize('kingu.home.card.modes.detail', "Agents and editor share a process. Switch with Ctrl+Shift+A."),
		},
		{
			name: localize('kingu.home.card.core.name', "Shared AI core"),
			detail: localize('kingu.home.card.core.detail', "Both modes talk to the same agent host over JSON-RPC."),
		},
		{
			name: localize('kingu.home.card.markdown.name', "Markdown-native"),
			detail: localize('kingu.home.card.markdown.detail', "Skills, agents and instructions are files you can read and diff."),
		},
		{
			name: localize('kingu.home.card.choice.name', "Bring your own agent"),
			detail: localize('kingu.home.card.choice.detail', "Claude, Codex and others register as session providers."),
		},
	];

	render(container: HTMLElement): void {
		const root = $('.kingu-home');

		const hero = $('.kingu-home-hero');
		hero.appendChild($('.kingu-home-title', undefined, localize('kingu.home.hero.title', "Kingu Intelligence")));
		hero.appendChild($('.kingu-home-subtitle', undefined,
			localize('kingu.home.hero.subtitle', "Agentic development environment with the editor built in.")));
		root.appendChild(hero);

		const section = $('.kingu-home-section');
		section.appendChild($('.kingu-home-section-title', undefined, localize('kingu.home.section.what', "What this shell gives you")));

		const cards = $('.kingu-home-cards');
		for (const capability of KinguHomeView.CAPABILITIES) {
			const card = $('.kingu-home-card');
			card.appendChild($('.kingu-home-card-name', undefined, capability.name));
			card.appendChild($('.kingu-home-card-detail', undefined, capability.detail));
			cards.appendChild(card);
		}
		section.appendChild(cards);
		root.appendChild(section);

		container.appendChild(root);
	}

	layout(_width: number, _height: number): void { }
}

class KinguHomeContribution extends Disposable {

	static readonly ID = 'kingu.contrib.home';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();

		this._register(customViewService.registerCustomView({
			id: KINGU_HOME_VIEW_ID,
			ctor: new SyncDescriptor(KinguHomeView),
		}));
	}
}

registerWorkbenchContribution2(KinguHomeContribution.ID, KinguHomeContribution, WorkbenchPhase.BlockRestore);

class ShowKinguHomeAction extends Action2 {

	constructor() {
		super({
			id: 'kingu.customView.showHome',
			title: localize2('kingu.showHome', "Kingu: Open Home"),
			category: Categories.View,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(KINGU_HOME_VIEW_ID);
	}
}

class HideKinguHomeAction extends Action2 {

	constructor() {
		super({
			id: 'kingu.customView.hideHome',
			title: localize2('kingu.hideHome', "Kingu: Close Home"),
			category: Categories.View,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).hideCustomView();
	}
}

registerAction2(ShowKinguHomeAction);
registerAction2(HideKinguHomeAction);
