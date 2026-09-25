/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksList.css';
import './media/kinguTasksGitHub.css';
import './media/kinguTasksGitLab.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { IKinguRepo } from '../common/kinguTasksGitHub.js';
import {
	formatGitLabReference,
	formatGitLabTodoAction,
	formatGitLabTypeState,
	getGitLabEmptyState,
	getGitLabIssueFilters,
	getGitLabIssueQuery,
	getGitLabMrFilters,
	getGitLabStateTone,
	getGitLabViews,
	GITLAB_PER_PROJECT_LIMIT,
	IKinguGitLabListResult,
	IKinguGitLabProjectRef,
	IKinguGitLabTodo,
	IKinguGitLabWorkItem,
	KinguGitLabIssueFilter,
	KinguGitLabMrFilter,
	KinguGitLabView,
	mergeGitLabResults,
} from '../common/kinguTasksGitLab.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { openExternalIssue } from './kinguTasksJiraList.js';
import { KinguTasksProjectPicker, renderRepoBadge } from './kinguTasksProjectPicker.js';

export interface IKinguGitLabListHost {
	readonly repos: readonly IKinguRepo[];
	hostLabel(repo: IKinguRepo): string;
	/** The reader changed the picked projects; `undefined` is "All projects". */
	setSelection(ids: readonly string[] | undefined): void;
}

/**
 * The ADE's GitLab source (`task-page/gitlab/Filters.tsx`, `ItemList.tsx`,
 * `TodoList.tsx`): Issues, merge requests and My Todos across the picked
 * projects, one `gitlab:*` call per project, merged newest first. As in the
 * ADE there is no search or pager; a project that is not on GitLab simply
 * adds nothing. The item dialog and starting a workspace follow.
 */
export class KinguTasksGitLabList extends Disposable {

	readonly element: HTMLElement = $('.kingu-tasks-list-surface.kingu-tasks-github.kingu-tasks-gitlab');

	private readonly _rendered = this._register(new DisposableStore());
	private readonly _chrome = this._register(new DisposableStore());
	private readonly _modes: HTMLElement;
	private readonly _picker: KinguTasksProjectPicker;
	private readonly _openProject: HTMLButtonElement;
	private readonly _chips: HTMLElement;
	private readonly _refresh: HTMLButtonElement;
	private readonly _header: HTMLElement;
	private readonly _body: HTMLElement;
	/** Each project's GitLab path, as its items report it. */
	private readonly _projectRefs = new Map<string, IKinguGitLabProjectRef>();

	private _selected: readonly IKinguRepo[];
	private _view: KinguGitLabView = 'mrs';
	private _mrFilter: KinguGitLabMrFilter = 'opened';
	private _issueFilter: KinguGitLabIssueFilter = 'opened';
	private _items: readonly IKinguGitLabWorkItem[] = [];
	private _todos: readonly IKinguGitLabTodo[] = [];
	private _error: string | undefined;
	private _loading = false;
	private _request = 0;

	constructor(
		private readonly _host: IKinguGitLabListHost,
		selectedIds: readonly string[],
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
		this._selected = this._host.repos.filter(repo => selectedIds.includes(repo.id));

		const controls = append(this.element, $('.kingu-tasks-gh-controls'));
		this._modes = append(controls, $('.kingu-tasks-gh-modes'));
		this._picker = this._register(new KinguTasksProjectPicker({
			repos: this._host.repos,
			hostLabel: repo => this._host.hostLabel(repo),
			selected: () => this._selected,
			apply: (repos, all) => {
				this._selected = repos;
				this._host.setSelection(all ? undefined : repos.map(repo => repo.id));
				this._syncChrome();
				void this._load();
			},
		}));
		controls.appendChild(this._picker.element);
		this._openProject = append(controls, $('button.kingu-tasks-gh-open-repo')) as HTMLButtonElement;
		this._openProject.type = 'button';
		this._openProject.appendChild(lucideIcon('external-link', 14));
		this._register(addDisposableListener(this._openProject, EventType.CLICK, () => {
			const url = this._projectUrl();
			if (url) {
				openExternalIssue(this._openerService, url);
			}
		}));

		const filters = append(this.element, $('.kingu-tasks-gh-filters'));
		const row = append(filters, $('.kingu-tasks-gh-search-row'));
		this._chips = append(row, $('.kingu-tasks-gh-presets'));
		const actions = append(row, $('.kingu-tasks-filters-actions'));
		this._refresh = append(actions, $('button.kingu-tasks-gh-action')) as HTMLButtonElement;
		this._refresh.type = 'button';
		this._register(this._hoverService.setupDelayedHover(this._refresh, () => ({ content: this._refresh.getAttribute('aria-label') ?? '', position: { hoverPosition: HoverPosition.BELOW } })));
		this._register(addDisposableListener(this._refresh, EventType.CLICK, () => void this._load()));

		const card = append(this.element, $('.kingu-tasks-gh-card'));
		const scroller = append(card, $('.kingu-tasks-gh-scroller'));
		this._header = append(scroller, $('.kingu-tasks-gh-header.kingu-tasks-gh-grid'));
		this._body = append(scroller, $('.kingu-tasks-gh-body'));

		this._syncChrome();
		void this._load();
	}

	/** One picked project's page on its GitLab host, once its path is known. */
	private _projectUrl(): string | undefined {
		const ref = this._selected.length === 1 ? this._projectRefs.get(this._selected[0].id) : undefined;
		return ref ? `https://${ref.host}/${ref.path.split('/').map(encodeURIComponent).join('/')}` : undefined;
	}

	private _syncChrome(): void {
		this._chrome.clear();
		clearNode(this._modes);
		for (const view of getGitLabViews()) {
			const button = append(this._modes, $('button.kingu-tasks-gh-mode')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = view.label;
			button.classList.toggle('active', this._view === view.id);
			button.setAttribute('aria-pressed', String(this._view === view.id));
			this._chrome.add(addDisposableListener(button, EventType.CLICK, () => {
				if (this._view !== view.id) {
					this._view = view.id;
					this._syncChrome();
					void this._load();
				}
			}));
		}
		this._picker.render();

		const ref = this._selected.length === 1 ? this._projectRefs.get(this._selected[0].id) : undefined;
		const openLabel = ref
			? localize('kingu.tasks.gitlab.openProject', "Open {0} in GitLab", ref.path)
			: localize('kingu.tasks.gitlab.openProjectHint', "Select one GitLab project to open in GitLab");
		this._openProject.setAttribute('aria-label', openLabel);
		this._openProject.disabled = !ref;
		this._chrome.add(this._hoverService.setupDelayedHover(this._openProject, { content: openLabel, position: { hoverPosition: HoverPosition.BELOW } }));

		// My Todos has no chips: it is every pending todo of the signed-in user.
		clearNode(this._chips);
		const chips: readonly { id: string; label: string }[] = this._view === 'mrs' ? getGitLabMrFilters() : this._view === 'issues' ? getGitLabIssueFilters() : [];
		for (const chip of chips) {
			const active = this._view === 'mrs' ? this._mrFilter === chip.id : this._issueFilter === chip.id;
			const button = append(this._chips, $('button.kingu-tasks-gh-preset')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = chip.label;
			button.classList.toggle('active', active);
			button.setAttribute('aria-pressed', String(active));
			this._chrome.add(addDisposableListener(button, EventType.CLICK, () => {
				if (this._view === 'mrs') {
					this._mrFilter = chip.id as KinguGitLabMrFilter;
				} else {
					this._issueFilter = chip.id as KinguGitLabIssueFilter;
				}
				this._syncChrome();
				void this._load();
			}));
		}

		this._refresh.disabled = this._loading;
		this._refresh.setAttribute('aria-label', this._loading
			? localize('kingu.tasks.gitlab.refreshing', "Refreshing GitLab work")
			: localize('kingu.tasks.gitlab.refresh', "Refresh GitLab work"));
		clearNode(this._refresh);
		this._refresh.appendChild(this._loading ? lucideIcon('loader-circle', 16, 'kingu-tasks-spin') : lucideIcon('refresh-cw', 16));

		clearNode(this._header);
		const columns = this._view === 'todos'
			? [localize('kingu.tasks.gitlab.colId', "ID"), localize('kingu.tasks.gitlab.colTodo', "Todo"), localize('kingu.tasks.gitlab.colAction', "Action"), localize('kingu.tasks.gitlab.colUpdated', "Updated"), '']
			: [localize('kingu.tasks.gitlab.colId', "ID"), localize('kingu.tasks.gitlab.colTitle', "Title"), localize('kingu.tasks.gitlab.colTypeState', "Type / State"), localize('kingu.tasks.gitlab.colUpdated', "Updated"), ''];
		for (const column of columns) {
			append(this._header, $('span')).textContent = column;
		}
	}

	private async _load(): Promise<void> {
		const request = ++this._request;
		const repos = this._selected;
		const view = this._view;
		this._loading = true;
		this._error = undefined;
		this._syncChrome();
		this._render();
		if (repos.length === 0) {
			this._items = [];
			this._todos = [];
			this._loading = false;
			this._syncChrome();
			this._render();
			return;
		}
		if (view === 'todos') {
			// Todos belong to the signed-in user, not a project: one call, through the first project's host.
			try {
				const todos = await this._orca.invoke<IKinguGitLabTodo[]>('gitlab:todos', { repoPath: repos[0].path, repoId: repos[0].id });
				if (request === this._request) {
					this._todos = todos ?? [];
				}
			} catch (error) {
				if (request === this._request) {
					this._todos = [];
					this._error = error instanceof Error ? error.message : String(error);
				}
			}
		} else {
			const results = await Promise.all(repos.map(async repo => {
				const selector = { repoPath: repo.path, repoId: repo.id };
				try {
					const result = view === 'mrs'
						? await this._orca.invoke<IKinguGitLabListResult>('gitlab:listMRs', { ...selector, state: this._mrFilter, page: 1, perPage: GITLAB_PER_PROJECT_LIMIT })
						: await this._orca.invoke<IKinguGitLabListResult>('gitlab:listIssues', { ...selector, ...getGitLabIssueQuery(this._issueFilter) });
					return { repoId: repo.id, result };
				} catch (error) {
					return { repoId: repo.id, result: undefined, thrown: error instanceof Error ? error.message : String(error) };
				}
			}));
			if (request !== this._request) {
				return;
			}
			const merged = mergeGitLabResults(results);
			this._items = merged.items;
			for (const item of merged.items) {
				if (item.projectRef && !this._projectRefs.has(item.repoId)) {
					this._projectRefs.set(item.repoId, item.projectRef);
				}
			}
			// As in the ADE, the banner is for when nothing loaded at all.
			if (merged.items.length === 0 && merged.errors.length > 0 && merged.errors.length === repos.length) {
				this._error = merged.errors[0].message;
			}
		}
		if (request !== this._request) {
			return;
		}
		this._loading = false;
		this._syncChrome();
		this._render();
	}

	private _render(): void {
		this._rendered.clear();
		const body = this._body;
		clearNode(body);
		if (this._error) {
			append(body, $('.kingu-tasks-credential-error')).textContent = this._error;
		}
		if (this._selected.length === 0) {
			const empty = append(body, $('.kingu-tasks-list-empty'));
			append(empty, $('p.kingu-tasks-gh-empty-title')).textContent = localize('kingu.tasks.noProjectSources', "No project sources selected");
			append(empty, $('p.kingu-tasks-list-empty-description')).textContent = localize('kingu.tasks.noProjectSourcesDescription', "Select at least one project source so Kingu knows which host/account to fetch tasks from.");
			return;
		}
		if (this._loading) {
			for (let i = 0; i < 10; i++) {
				const row = append(body, $('.kingu-tasks-gh-skeleton.kingu-tasks-gh-grid'));
				for (let cell = 0; cell < 4; cell++) {
					append(row, $('span.kingu-tasks-gh-skeleton-bar'));
				}
			}
			return;
		}
		const count = this._view === 'todos' ? this._todos.length : this._items.length;
		if (count === 0 && !this._error) {
			const state = getGitLabEmptyState(this._view);
			const empty = append(body, $('.kingu-tasks-list-empty'));
			append(empty, $('p.kingu-tasks-gh-empty-title')).textContent = state.title;
			append(empty, $('p.kingu-tasks-list-empty-description')).textContent = state.description;
			return;
		}
		const rows = append(body, $('.kingu-tasks-gh-rows'));
		if (this._view === 'todos') {
			for (const todo of this._todos) {
				this._renderTodo(rows, todo);
			}
		} else {
			for (const item of this._items) {
				this._renderItem(rows, item);
			}
		}
	}

	private _renderItem(parent: HTMLElement, item: IKinguGitLabWorkItem): void {
		const row = append(parent, $('.kingu-tasks-gh-row.kingu-tasks-gh-grid'));
		const repo = this._selected.find(candidate => candidate.id === item.repoId);
		const pill = append(append(row, $('.kingu-tasks-gh-cell-id')), $('span.kingu-tasks-gh-id'));
		pill.appendChild(lucideIcon(item.type === 'mr' ? 'git-pull-request' : 'circle-dot', 12, item.type === 'mr' ? `kingu-tasks-gh-pr-icon ${getGitLabStateTone(item.state)}` : undefined));
		append(pill, $('span.kingu-tasks-gh-number')).textContent = formatGitLabReference(item);

		const titleCell = append(row, $('.kingu-tasks-gh-cell-title'));
		const titleLine = append(titleCell, $('.kingu-tasks-title-line'));
		append(titleLine, $('h3.kingu-tasks-title')).textContent = item.title;
		if (repo && this._selected.length > 1) {
			renderRepoBadge(append(titleLine, $('span.kingu-tasks-gh-title-repo')), repo);
		}
		const context = append(titleCell, $('.kingu-tasks-gh-context'));
		append(context, $('span')).textContent = item.author || localize('kingu.tasks.gitlab.unknownAuthor', "unknown author");
		if (item.projectRef) {
			append(context, $('span')).textContent = item.projectRef.path;
		}
		for (const label of item.labels.slice(0, 3)) {
			append(context, $('span.kingu-tasks-gh-label')).textContent = label;
		}

		append(append(row, $('.kingu-tasks-gh-cell-status')), $(`span.kingu-tasks-gh-status.${getGitLabStateTone(item.state)}`)).textContent = formatGitLabTypeState(item);
		this._renderUpdated(row, item.updatedAt);
		this._renderOpen(row, item.url);
	}

	private _renderTodo(parent: HTMLElement, todo: IKinguGitLabTodo): void {
		const row = append(parent, $('.kingu-tasks-gh-row.kingu-tasks-gh-grid'));
		const pill = append(append(row, $('.kingu-tasks-gh-cell-id')), $('span.kingu-tasks-gh-id'));
		const isMr = todo.targetType === 'MergeRequest';
		pill.appendChild(lucideIcon(isMr ? 'git-pull-request' : 'circle-dot', 12));
		append(pill, $('span.kingu-tasks-gh-number')).textContent = todo.targetIid !== null ? formatGitLabReference({ type: isMr ? 'mr' : 'issue', number: todo.targetIid }) : '-';

		const titleCell = append(row, $('.kingu-tasks-gh-cell-title'));
		append(append(titleCell, $('.kingu-tasks-title-line')), $('h3.kingu-tasks-title')).textContent = todo.targetTitle;
		const context = append(titleCell, $('.kingu-tasks-gh-context'));
		if (todo.authorUsername) {
			append(context, $('span')).textContent = todo.authorUsername;
		}
		if (todo.projectPath) {
			append(context, $('span')).textContent = todo.projectPath;
		}

		append(append(row, $('.kingu-tasks-gh-cell-status')), $('span.kingu-tasks-gh-status.open')).textContent = formatGitLabTodoAction(todo.actionName);
		this._renderUpdated(row, todo.updatedAt);
		this._renderOpen(row, todo.targetUrl);
	}

	private _renderUpdated(row: HTMLElement, iso: string): void {
		const updated = append(row, $('.kingu-tasks-gh-cell-updated'));
		const at = new Date(iso);
		updated.textContent = Number.isNaN(at.getTime()) ? '-' : fromNow(at, true);
		if (!Number.isNaN(at.getTime())) {
			this._rendered.add(this._hoverService.setupDelayedHover(updated, { content: at.toLocaleString(), position: { hoverPosition: HoverPosition.BELOW } }));
		}
	}

	private _renderOpen(row: HTMLElement, url: string): void {
		const actions = append(row, $('.kingu-tasks-gh-cell-actions'));
		const open = append(actions, $('button.kingu-tasks-row-action')) as HTMLButtonElement;
		open.type = 'button';
		const label = localize('kingu.tasks.gitlab.openInGitLab', "Open in GitLab");
		open.setAttribute('aria-label', label);
		open.appendChild(lucideIcon('external-link', 14));
		this._rendered.add(this._hoverService.setupDelayedHover(open, { content: label, position: { hoverPosition: HoverPosition.BELOW } }));
		this._rendered.add(addDisposableListener(open, EventType.CLICK, () => openExternalIssue(this._openerService, url)));
	}
}
