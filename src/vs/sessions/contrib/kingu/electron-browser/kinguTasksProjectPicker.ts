/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IKinguRepo } from '../common/kinguTasksGitHub.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';

export interface IKinguTasksProjectPickerHost {
	/** The projects the picker offers: the ADE's eligible repos. */
	readonly repos: readonly IKinguRepo[];
	/** Where a repo runs, as the picker's rows name it. */
	hostLabel(repo: IKinguRepo): string;
	selected(): readonly IKinguRepo[];
	/** The reader picked `repos`; `all` when that is "All projects". */
	apply(repos: readonly IKinguRepo[], all: boolean): void;
}

/** A project's name with its colour dot, as the ADE badges a repo. */
export function renderRepoBadge(parent: HTMLElement, repo: IKinguRepo): void {
	const badge = append(parent, $('span.kingu-tasks-gh-repo-badge'));
	const dot = append(badge, $('span.kingu-tasks-gh-repo-dot'));
	if (repo.badgeColor && /^#[0-9a-f]{3,8}$/i.test(repo.badgeColor)) {
		dot.style.backgroundColor = repo.badgeColor;
	}
	append(badge, $('span.truncate')).textContent = repo.displayName;
}

/**
 * The ADE's `TaskProjectSourceCombobox`, which its GitHub and GitLab sources
 * share: the picked projects on the button, and a popover with a search, "All
 * projects" and a check row per project.
 */
export class KinguTasksProjectPicker extends Disposable {

	readonly element: HTMLElement = $('.kingu-tasks-gh-picker-wrap');

	private readonly _button: HTMLButtonElement;
	private readonly _popover = this._register(new MutableDisposable<DisposableStore>());

	constructor(private readonly _host: IKinguTasksProjectPickerHost) {
		super();
		this._button = append(this.element, $('button.kingu-tasks-gh-picker')) as HTMLButtonElement;
		this._button.type = 'button';
		this._button.setAttribute('role', 'combobox');
		this._button.setAttribute('aria-haspopup', 'listbox');
		this._register(addDisposableListener(this._button, EventType.CLICK, () => this._toggle()));
	}

	/** The button's label: none, all, or the first two picked and how many more. */
	render(): void {
		const selected = this._host.selected();
		clearNode(this._button);
		const label = append(this._button, $('span.kingu-tasks-gh-picker-label'));
		if (selected.length === 0) {
			append(label, $('span.muted')).textContent = localize('kingu.tasks.github.noProjects', "No projects");
		} else if (selected.length === this._host.repos.length && this._host.repos.length > 1) {
			label.textContent = localize('kingu.tasks.github.allProjects', "All projects");
		} else {
			renderRepoBadge(label, selected[0]);
			if (selected[1]) {
				append(label, $('span.muted')).textContent = `, ${selected[1].displayName}`;
			}
			if (selected.length > 2) {
				append(label, $('span')).textContent = `+${selected.length - 2}`;
			}
		}
		this._button.appendChild(lucideIcon('chevrons-up-down', 14, 'kingu-tasks-gh-picker-chevron'));
	}

	private _toggle(): void {
		if (this._popover.value) {
			this._popover.clear();
			return;
		}
		const store = new DisposableStore();
		this._popover.value = store;
		const anchor = this.element;
		const popover = append(anchor, $('.kingu-tasks-gh-popover'));
		store.add({ dispose: () => popover.remove() });
		this._button.setAttribute('aria-expanded', 'true');
		store.add({ dispose: () => this._button.setAttribute('aria-expanded', 'false') });

		const search = append(popover, $('input.kingu-tasks-gh-popover-search')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = localize('kingu.tasks.github.searchProjects', "Search projects...");
		search.setAttribute('aria-label', search.placeholder);
		const list = append(popover, $('.kingu-tasks-gh-popover-list'));
		list.setAttribute('role', 'listbox');

		const draw = () => {
			clearNode(list);
			const selected = this._host.selected();
			const query = search.value.trim().toLowerCase();
			const all = append(list, $('.kingu-tasks-gh-popover-all'));
			const allButton = append(all, $('button.kingu-tasks-gh-popover-row')) as HTMLButtonElement;
			allButton.type = 'button';
			const allSelected = selected.length === this._host.repos.length;
			allButton.appendChild(lucideIcon('check', 12, allSelected ? 'kingu-tasks-gh-check on' : 'kingu-tasks-gh-check'));
			append(allButton, $('span')).textContent = localize('kingu.tasks.github.allProjects', "All projects");
			store.add(addDisposableListener(allButton, EventType.CLICK, () => {
				// Clicking All while everything is picked narrows to the first project, as the ADE does.
				this._host.apply(allSelected ? this._host.repos.slice(0, 1) : [...this._host.repos], !allSelected);
				draw();
			}));
			const matches = this._host.repos.filter(repo => !query || repo.displayName.toLowerCase().includes(query) || repo.path.toLowerCase().includes(query));
			if (matches.length === 0) {
				append(list, $('.kingu-tasks-gh-popover-empty')).textContent = localize('kingu.tasks.github.noProjectMatch', "No projects match your search.");
			}
			for (const repo of matches) {
				const checked = selected.includes(repo);
				const row = append(list, $('button.kingu-tasks-gh-popover-row.project')) as HTMLButtonElement;
				row.type = 'button';
				row.setAttribute('role', 'option');
				row.setAttribute('aria-selected', String(checked));
				row.appendChild(lucideIcon('check', 12, checked ? 'kingu-tasks-gh-check on' : 'kingu-tasks-gh-check'));
				const text = append(row, $('span.kingu-tasks-gh-popover-text'));
				renderRepoBadge(text, repo);
				const hostLabel = this._host.hostLabel(repo);
				append(text, $('span.kingu-tasks-gh-popover-path')).textContent = hostLabel ? `${hostLabel} · ${repo.path}` : repo.path;
				store.add(addDisposableListener(row, EventType.CLICK, () => {
					const next = checked ? selected.filter(candidate => candidate !== repo) : [...selected, repo];
					// Unticking the last project is a no-op: the page always has a source.
					if (next.length > 0) {
						this._host.apply(this._host.repos.filter(candidate => next.includes(candidate)), false);
						draw();
					}
				}));
			}
		};
		draw();
		store.add(addDisposableListener(search, EventType.INPUT, draw));
		store.add(addDisposableListener(getWindow(anchor).document, EventType.MOUSE_DOWN, (event: MouseEvent) => {
			if (!anchor.contains(event.target as Node)) {
				this._popover.clear();
			}
		}, true));
		store.add(addDisposableListener(popover, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				this._popover.clear();
				this._button.focus();
			}
		}));
		search.focus();
	}
}
