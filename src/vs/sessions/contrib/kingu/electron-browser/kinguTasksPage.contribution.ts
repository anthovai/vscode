/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksPage.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import {
	IKinguTaskProvider,
	IKinguTasksService,
	KinguTaskProviderState,
} from '../../../../platform/kinguTasks/common/kinguTasks.js';
import { KinguTasksService } from './kinguTasksService.js';

export const KINGU_TASKS_VIEW_ID = 'kingu.customView.tasks';
export const KINGU_SHOW_TASKS_COMMAND_ID = 'kingu.tasks.show';

// Delayed: the providers are the ADE's and answering costs a trip to the main
// process, so nothing should pay for it until someone opens the page.
registerSingleton(IKinguTasksService, KinguTasksService, InstantiationType.Delayed);

/** What each state looks like, and what it means for the reader. */
function describe(state: KinguTaskProviderState): { icon: ThemeIcon; className: string; label: string } {
	switch (state) {
		case KinguTaskProviderState.Connected:
			return {
				icon: Codicon.pass,
				className: 'connected',
				label: localize('kingu.tasks.connected', "Connected"),
			};
		case KinguTaskProviderState.Disconnected:
			return {
				icon: Codicon.circleLargeOutline,
				className: 'disconnected',
				label: localize('kingu.tasks.disconnected', "Not connected"),
			};
		case KinguTaskProviderState.Unavailable:
			return {
				icon: Codicon.circleSlash,
				className: 'unavailable',
				// Deliberately not "not connected": this build cannot ask the
				// provider anything yet, so offering a sign-in would lead nowhere.
				label: localize('kingu.tasks.unavailable', "Not available in this build"),
			};
	}
}

/**
 * Where Kingu pulls work from.
 *
 * The first capability moved across from the ADE under the settled direction:
 * the Agents Window is the program, and the ADE answers behind it. This window
 * had no Tasks page at all; the ADE has four providers already implemented and
 * already running in this process, so the page asks them rather than growing a
 * second implementation of four issue trackers.
 *
 * It lists all four whatever their state. A tracker that is signed out is not
 * the same as one that does not exist, and a reader deciding where to get work
 * from needs to see both.
 */
class KinguTasksView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('kingu.tasks.pageTitle', "Tasks"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('kingu.tasks.pageDescription', "The issue trackers Kingu can pull work from, and whether each one is connected."));

	private _container: HTMLElement | undefined;
	private _providers: readonly IKinguTaskProvider[] | undefined;

	constructor(
		@IKinguTasksService private readonly _tasksService: IKinguTasksService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		this._container = container;
		this._draw();
		void this._load();
	}

	private async _load(): Promise<void> {
		try {
			this._providers = await this._tasksService.getProviders();
		} catch (error) {
			// Drawn as an empty list with its message rather than thrown: the
			// page failing to reach the ADE is a thing to report on the page.
			this._providers = [];
		}
		this._draw();
	}

	private _draw(): void {
		const container = this._container;
		if (!container) {
			return;
		}
		clearNode(container);
		container.classList.add('kingu-tasks-page');

		if (!this._providers) {
			append(container, $('.kingu-tasks-loading')).textContent =
				localize('kingu.tasks.loading', "Asking each provider…");
			return;
		}

		if (this._providers.length === 0) {
			append(container, $('.kingu-tasks-empty')).textContent =
				localize('kingu.tasks.unreachable', "Could not reach the task providers.");
			return;
		}

		const list = append(container, $('.kingu-tasks-list'));
		for (const provider of this._providers) {
			const { icon, className, label } = describe(provider.state);
			const row = append(list, $(`.kingu-tasks-row.${className}`));
			append(row, $(`.kingu-tasks-row-icon${ThemeIcon.asCSSSelector(icon)}`));
			append(row, $('.kingu-tasks-row-name')).textContent = provider.label;
			append(row, $('.kingu-tasks-row-state')).textContent = label;
		}
	}

	layout(_width: number, _height: number): void { }
}

class KinguTasksPageContribution extends Disposable {

	static readonly ID = 'kingu.contrib.tasksPage';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		this._register(customViewService.registerCustomView({
			id: KINGU_TASKS_VIEW_ID,
			ctor: new SyncDescriptor(KinguTasksView),
		}));
	}
}

registerWorkbenchContribution2(KinguTasksPageContribution.ID, KinguTasksPageContribution, WorkbenchPhase.BlockRestore);

class ShowKinguTasksAction extends Action2 {

	constructor() {
		super({
			id: KINGU_SHOW_TASKS_COMMAND_ID,
			title: localize2('kingu.showTasks', "Kingu: Tasks"),
			category: Categories.View,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(KINGU_TASKS_VIEW_ID);
	}
}

registerAction2(ShowKinguTasksAction);
