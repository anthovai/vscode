/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ISCMViewService } from '../../scm/common/scm.js';

/** Recent folders and workspaces, the project switcher. */
const OPEN_RECENT_COMMAND_ID = 'workbench.action.openRecent';
/** The git extension's branch picker, on the active repository. */
const GIT_CHECKOUT_COMMAND_ID = 'git.checkout';

/**
 * The project and branch at the front of the title bar's command center pill,
 * each a button: the project opens the recent folders, the branch the branch
 * picker. VS Code shows the folder name as the search box's placeholder and
 * the branch only in the status bar; in Kingu the pill says where the work is
 * happening, and what the agents are doing about it (`kinguAgentStatusText` in common/kinguTitleBar.ts).
 */
export class KinguTitleBarContext extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the active repository or its branch changes, so the pill renders again. */
	readonly onDidChange = this._onDidChange.event;

	private _branch: string | undefined;
	/** The active repository's root, so the branch picker does not ask which repository first. */
	private _repositoryRoot: URI | undefined;

	constructor(
		@ISCMViewService scmViewService: ISCMViewService,
		@ICommandService private readonly _commandService: ICommandService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();
		this._register(autorun(reader => {
			const repository = scmViewService.activeRepository.read(reader)?.repository;
			const branch = repository?.provider.historyProvider.read(reader)?.historyItemRef.read(reader)?.name;
			const root = repository?.provider.rootUri;
			if (branch !== this._branch || root?.toString() !== this._repositoryRoot?.toString()) {
				this._branch = branch;
				this._repositoryRoot = root;
				this._onDidChange.fire();
			}
		}));
	}

	/** What the rendered segments depend on, for the pill's render cache. */
	get stateKey(): string {
		return `${this._repositoryRoot?.toString() ?? ''}#${this._branch ?? ''}`;
	}

	/**
	 * Renders the project (`projectName`, the workspace's name) and the branch
	 * into `container`, and returns the buttons in order for the pill's roving
	 * focus. Nothing is rendered without a workspace.
	 */
	render(container: HTMLElement, projectName: string | undefined, disposables: DisposableStore): HTMLElement[] {
		if (!projectName) {
			return [];
		}
		const segments = append(container, $('span.kingu-title-context'));
		const buttons = [
			this._segment(segments, Codicon.folder, projectName, localize('kingu.titleBar.project', "Switch Project"), OPEN_RECENT_COMMAND_ID, disposables),
		];
		if (this._branch) {
			buttons.push(this._segment(segments, Codicon.gitBranch, this._branch, localize('kingu.titleBar.branch', "Switch Branch"), GIT_CHECKOUT_COMMAND_ID, disposables, this._repositoryRoot));
		}
		return buttons;
	}

	private _segment(parent: HTMLElement, icon: ThemeIcon, label: string, tooltip: string, commandId: string, disposables: DisposableStore, ...args: unknown[]): HTMLElement {
		const button = append(parent, $('span.kingu-title-segment', { role: 'button', tabIndex: 0, 'aria-label': `${tooltip}: ${label}` }));
		append(button, renderIcon(icon));
		append(button, $('span.kingu-title-segment-label')).textContent = label;
		append(button, renderIcon(Codicon.chevronDown)).classList.add('kingu-title-segment-chevron');
		disposables.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), button, tooltip));
		const run = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			this._commandService.executeCommand(commandId, ...args);
		};
		disposables.add(addDisposableListener(button, EventType.CLICK, run));
		disposables.add(addDisposableListener(button, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				run(e);
			}
		}));
		return button;
	}
}
