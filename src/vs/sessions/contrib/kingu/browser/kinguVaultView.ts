/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguVault.css';
import { $, addDisposableListener, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { fromNow } from '../../../../base/common/date.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { IKinguVaultService, IKinguVaultSession } from '../common/kinguVault.js';
import { KINGU_VAULT_SOURCES } from '../common/kinguVaultSources.js';

export const KINGU_VAULT_VIEW_ID = 'kingu.customView.vault';

/**
 * The vault as a surface rather than a quick pick.
 *
 * The picker answers "open that one"; this answers "what is in here" — which
 * agents the user has actually used, how much history each holds, and what they
 * were working on. That is a thing to look at, not a thing to dismiss.
 *
 * None of the ADE's vault UI came across. The markup is this fork's, and every
 * colour is a workbench token, so the view wears the Agents window's theme.
 */
export class KinguVaultView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('kingu.vault.view.title', "Vault"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('kingu.vault.view.description', "Sessions from every coding agent on this machine."));

	private readonly _rendered = this._register(new DisposableStore());
	private _sessions: readonly IKinguVaultSession[] = [];
	private _filter = '';
	/** Source ids the user has turned off. Empty means every source is shown. */
	private readonly _hidden = new Set<string>();
	private _listContainer: HTMLElement | undefined;
	private _generation = 0;
	/** Sessions whose workers are showing, by id. */
	private readonly _expanded = new Set<string>();

	constructor(
		@IKinguVaultService private readonly _vaultService: IKinguVaultService,
		@IEditorService private readonly _editorService: IEditorService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._register(this._vaultService.onDidChangeSessions(() => this._load()));
	}

	render(container: HTMLElement): void {
		this._rendered.clear();
		clearNode(container);

		const root = $('.kingu-vault');
		root.appendChild(this._renderHeader());

		this._listContainer = $('.kingu-vault-list');
		root.appendChild(this._listContainer);
		container.appendChild(root);

		this._renderList();
		this._load();
	}

	private _renderHeader(): HTMLElement {
		const header = $('.kingu-vault-header');
		header.appendChild($('.kingu-vault-title', undefined, localize('kingu.vault.view.heading', "Kingu Vault")));
		header.appendChild($('.kingu-vault-subtitle', undefined,
			localize('kingu.vault.view.blurb', "Every session these agents have left on this machine, read from their own files.")));

		const controls = $('.kingu-vault-controls');
		const filter = $('input.kingu-vault-filter') as HTMLInputElement;
		filter.type = 'text';
		filter.placeholder = localize('kingu.vault.view.filterPlaceholder', "Filter by title or folder");
		filter.setAttribute('aria-label', localize('kingu.vault.view.filterLabel', "Filter vault sessions"));
		this._rendered.add(addDisposableListener(filter, EventType.INPUT, () => {
			this._filter = filter.value.trim().toLowerCase();
			this._renderList();
		}));
		controls.appendChild(filter);
		header.appendChild(controls);

		// One chip per agent the vault knows how to read, whether or not it is
		// installed: an absent agent showing no sessions is itself an answer.
		const sources = $('.kingu-vault-sources');
		for (const source of KINGU_VAULT_SOURCES) {
			const chip = $('.kingu-vault-source.checked', { role: 'checkbox', tabIndex: 0, 'aria-checked': 'true' }, source.label);
			const toggle = () => {
				const nowHidden = !this._hidden.has(source.id);
				if (nowHidden) {
					this._hidden.add(source.id);
				} else {
					this._hidden.delete(source.id);
				}
				chip.classList.toggle('checked', !nowHidden);
				chip.setAttribute('aria-checked', String(!nowHidden));
				this._renderList();
			};
			this._rendered.add(addDisposableListener(chip, EventType.CLICK, toggle));
			this._rendered.add(addDisposableListener(chip, EventType.KEY_DOWN, event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					toggle();
				}
			}));
			sources.appendChild(chip);
		}
		header.appendChild(sources);
		return header;
	}

	private _load(): void {
		// The scan is the service's and is shared; this only counts requests so a
		// result that arrived for a list already replaced is dropped rather than
		// rendered over a newer one. Cancelling the service's scan from here would
		// abort the walk every other caller is waiting on.
		const generation = ++this._generation;
		this._vaultService.getSessions().then(sessions => {
			if (generation === this._generation) {
				this._sessions = sessions;
				this._renderList();
			}
		}, () => { /* a vault that cannot be read renders as an empty one */ });
	}

	private _renderList(): void {
		const container = this._listContainer;
		if (!container) {
			return;
		}
		clearNode(container);
		const visible = this._sessions.filter(session => this._matches(session));
		if (visible.length === 0) {
			container.appendChild($('.kingu-vault-empty', undefined, this._sessions.length === 0
				? localize('kingu.vault.view.scanning', "No sessions found yet. Scanning runs on demand — use Kingu: Refresh Vault after starting one.")
				: localize('kingu.vault.view.noMatches', "No sessions match this filter.")));
			return;
		}
		for (const session of visible) {
			container.appendChild(this._renderRow(session));
			if (this._expanded.has(session.id)) {
				container.appendChild(this._renderSubagents(session));
			}
		}
	}

	/**
	 * The workers a session handed tasks to, under the row that spawned them.
	 *
	 * Loaded when the row is opened rather than during the scan: most sessions
	 * spawn none, and reading every session's worker directory would add a
	 * directory listing per row to a scan that already reads a file per row.
	 */
	private _renderSubagents(session: IKinguVaultSession): HTMLElement {
		const container = $('.kingu-vault-subagents');
		container.appendChild($('.kingu-vault-subagent-loading', undefined, localize('kingu.vault.view.loadingWorkers', "Loading workers…")));
		const generation = this._generation;
		this._vaultService.getSubagents(session).then(subagents => {
			// The list may have been replaced while this was loading.
			if (generation !== this._generation || !container.isConnected) {
				return;
			}
			clearNode(container);
			if (subagents.length === 0) {
				container.appendChild($('.kingu-vault-subagent-loading', undefined, localize('kingu.vault.view.noWorkers', "This session delegated nothing.")));
				return;
			}
			for (const subagent of subagents) {
				const row = $('.kingu-vault-subagent', { role: 'button', tabIndex: 0, title: subagent.title });
				row.appendChild($('.kingu-vault-subagent-title', undefined, subagent.title));
				const openWorker = () => { void this._editorService.openEditor({ resource: subagent.resource, options: { pinned: true } }); };
				this._rendered.add(addDisposableListener(row, EventType.CLICK, openWorker));
				this._rendered.add(addDisposableListener(row, EventType.KEY_DOWN, event => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						openWorker();
					}
				}));
				container.appendChild(row);
			}
		}, () => { /* a session whose workers cannot be read shows none */ });
		return container;
	}

	private _matches(session: IKinguVaultSession): boolean {
		if (this._hidden.has(session.source)) {
			return false;
		}
		if (!this._filter) {
			return true;
		}
		return session.title.toLowerCase().includes(this._filter)
			|| (session.workingDirectory?.toLowerCase().includes(this._filter) ?? false)
			// So a machine's name finds its sessions, which is how a person looks for
			// "what was I doing on the build box".
			|| (session.hostLabel?.toLowerCase().includes(this._filter) ?? false);
	}

	private _renderRow(session: IKinguVaultSession): HTMLElement {
		const row = $('.kingu-vault-row', { role: 'button', tabIndex: 0 });
		row.appendChild($('.kingu-vault-row-title', { title: session.title }, session.title));

		const meta = $('.kingu-vault-row-meta');
		meta.appendChild($('.kingu-vault-row-source', undefined, session.sourceLabel));
		// Only on a row that is somewhere else. A badge on every row saying "this
		// computer" would be a badge on nothing, and the badge is here to make the
		// handful of remote rows findable among hundreds of local ones.
		if (session.hostLabel) {
			meta.appendChild($('.kingu-vault-row-host', {
				title: localize('kingu.vault.view.hostTooltip', "On {0}", session.hostLabel),
			}, session.hostLabel));
		}
		// Offered on every row rather than only where workers exist: knowing there
		// are none is an answer, and finding out costs a directory listing that the
		// scan deliberately does not pay for every row.
		const expanded = this._expanded.has(session.id);
		const workers = $('a.kingu-vault-row-workers', {
			role: 'button',
			tabIndex: 0,
			title: localize('kingu.vault.view.workersTooltip', "Show the workers this session delegated to"),
		}, expanded
			? localize('kingu.vault.view.hideWorkers', "Hide workers")
			: localize('kingu.vault.view.showWorkers', "Workers"));
		const toggleWorkers = () => {
			if (this._expanded.has(session.id)) {
				this._expanded.delete(session.id);
			} else {
				this._expanded.add(session.id);
			}
			this._renderList();
		};
		this._rendered.add(addDisposableListener(workers, EventType.CLICK, event => {
			event.stopPropagation();
			toggleWorkers();
		}));
		this._rendered.add(addDisposableListener(workers, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				event.stopPropagation();
				toggleWorkers();
			}
		}));
		meta.appendChild(workers);
		if (session.workingDirectory) {
			meta.appendChild($('.kingu-vault-row-directory', { title: session.workingDirectory }, session.workingDirectory));
		}
		if (session.modified) {
			meta.appendChild($('.kingu-vault-row-modified', undefined, fromNow(session.modified, true)));
		}
		row.appendChild(meta);

		// Continuing is the reason to keep a past session, so it is the action on the
		// row; reading the raw transcript stays a click away on the title.
		const continueSession = () => { void this._commandService.executeCommand('kingu.vault.continue', session); };
		const continueButton = $('a.kingu-vault-row-continue', {
			role: 'button',
			tabIndex: 0,
			title: localize('kingu.vault.view.continueTooltip', "Continue this session here, with its history imported"),
		}, localize('kingu.vault.view.continue', "Continue"));
		this._rendered.add(addDisposableListener(continueButton, EventType.CLICK, event => {
			// The row opens the transcript; this button must not do both.
			event.stopPropagation();
			continueSession();
		}));
		this._rendered.add(addDisposableListener(continueButton, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				event.stopPropagation();
				continueSession();
			}
		}));
		meta.appendChild(continueButton);

		const remove = () => { void this._commandService.executeCommand('kingu.vault.delete', session); };
		const deleteButton = $('a.kingu-vault-row-delete', {
			role: 'button',
			tabIndex: 0,
			title: localize('kingu.vault.view.deleteTooltip', "Delete this session's transcript from disk"),
		}, localize('kingu.vault.view.delete', "Delete"));
		this._rendered.add(addDisposableListener(deleteButton, EventType.CLICK, event => {
			event.stopPropagation();
			remove();
		}));
		this._rendered.add(addDisposableListener(deleteButton, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				event.stopPropagation();
				remove();
			}
		}));
		meta.appendChild(deleteButton);

		const open = () => { void this._editorService.openEditor({ resource: session.resource, options: { pinned: true } }); };
		this._rendered.add(addDisposableListener(row, EventType.CLICK, open));
		this._rendered.add(addDisposableListener(row, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				open();
			}
		}));
		return row;
	}

	layout(_width: number, _height: number): void { }
}
