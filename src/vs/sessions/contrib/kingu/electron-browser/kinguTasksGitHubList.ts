/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksList.css';
import './media/kinguTasksGitHub.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import {
	getDefaultPreset,
	getGitHubPresets,
	getPageNumbers,
	getPerRepoLimit,
	getPresetQuery,
	getQueryKind,
	getRepoGitHubSlug,
	getTotalPages,
	getWorkItemStatus,
	IKinguGitHubSlug,
	IKinguGitHubWorkItem,
	IKinguListWorkItemsResult,
	IKinguRepo,
	KinguGitHubPreset,
	KinguGitHubTaskKind,
	scopeGitHubTaskSearch,
	sortWorkItemsByNumber,
	stripRepoQualifiers,
} from '../common/kinguTasksGitHub.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { openExternalIssue } from './kinguTasksJiraList.js';

/** The ADE's `GITHUB_TASK_SEARCH_IDLE_MS`. */
const SEARCH_IDLE_MS = 750;

interface IRepoPage {
	readonly items: readonly IKinguGitHubWorkItem[];
	readonly error?: string;
}

export interface IKinguGitHubListHost {
	/** The projects the picker offers: the ADE's eligible repos. */
	readonly repos: readonly IKinguRepo[];
	/** Where a repo runs, as the summary names it. */
	hostLabel(repo: IKinguRepo): string;
	/** The reader changed the picked projects; `undefined` is "All projects". */
	setSelection(ids: readonly string[] | undefined): void;
}

/**
 * The ADE's GitHub source: `task-page/github/ModeControls.tsx` (Issues / PRs
 * and the project picker), `Filters.tsx`, `List.tsx`, `Rows.tsx` and
 * `task-page/PaginationBar.tsx`, read only. The Projects mode, the Filters
 * menu, creating an issue, the detail drawer and starting a workspace follow.
 */
export class KinguTasksGitHubList extends Disposable {

	readonly element: HTMLElement = $('.kingu-tasks-list-surface.kingu-tasks-github');

	private readonly _rendered = this._register(new DisposableStore());
	private readonly _chrome = this._register(new DisposableStore());
	private readonly _popover = this._register(new MutableDisposable<DisposableStore>());
	private readonly _modes: HTMLElement;
	private readonly _picker: HTMLButtonElement;
	private readonly _openRepo: HTMLButtonElement;
	private readonly _presets: HTMLElement;
	private readonly _search: HTMLInputElement;
	private readonly _clear: HTMLButtonElement;
	private readonly _refresh: HTMLButtonElement;
	private readonly _header: HTMLElement;
	private readonly _scroller: HTMLElement;
	private readonly _body: HTMLElement;
	private readonly _pagination: HTMLElement;

	private _selected: readonly IKinguRepo[] = [];
	private _kind: KinguGitHubTaskKind = 'issues';
	private _preset: KinguGitHubPreset | undefined = 'issues';
	private _query = getPresetQuery('issues');
	private _page = 1;
	private _totalPages: number | undefined;
	private _items: readonly IKinguGitHubWorkItem[] = [];
	private _repoErrors: readonly { repo: IKinguRepo; message: string }[] = [];
	private _sources: IKinguGitHubSlug | undefined;
	private _error: string | undefined;
	private _loading = false;
	private _request = 0;
	private _debounce: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _host: IKinguGitHubListHost,
		selectedIds: readonly string[],
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
		this._register({ dispose: () => clearTimeout(this._debounce) });
		this._selected = this._host.repos.filter(repo => selectedIds.includes(repo.id));

		// `ModeControls`: Issues / PRs, the project picker and the open-in-GitHub link.
		const controls = append(this.element, $('.kingu-tasks-gh-controls'));
		this._modes = append(controls, $('.kingu-tasks-gh-modes'));
		const pickerWrap = append(controls, $('.kingu-tasks-gh-picker-wrap'));
		this._picker = append(pickerWrap, $('button.kingu-tasks-gh-picker')) as HTMLButtonElement;
		this._picker.type = 'button';
		this._picker.setAttribute('role', 'combobox');
		this._picker.setAttribute('aria-haspopup', 'listbox');
		this._register(addDisposableListener(this._picker, EventType.CLICK, () => this._togglePicker(pickerWrap)));
		this._openRepo = append(controls, $('button.kingu-tasks-gh-open-repo')) as HTMLButtonElement;
		this._openRepo.type = 'button';
		this._openRepo.appendChild(lucideIcon('external-link', 14));
		this._register(addDisposableListener(this._openRepo, EventType.CLICK, () => {
			const url = this._repoUrl();
			if (url) {
				openExternalIssue(this._openerService, url);
			}
		}));

		// `Filters.tsx`: presets, then the search and the actions.
		const filters = append(this.element, $('.kingu-tasks-gh-filters'));
		this._presets = append(filters, $('.kingu-tasks-gh-presets'));
		const searchRow = append(filters, $('.kingu-tasks-gh-search-row'));
		const searchBox = append(searchRow, $('.kingu-tasks-gh-search'));
		searchBox.appendChild(lucideIcon('search', 14, 'kingu-tasks-search-icon'));
		this._search = append(searchBox, $('input.kingu-tasks-gh-search-input')) as HTMLInputElement;
		this._search.type = 'text';
		this._search.spellcheck = false;
		this._search.value = this._query;
		this._clear = append(searchBox, $('button.kingu-tasks-search-clear')) as HTMLButtonElement;
		this._clear.type = 'button';
		this._clear.setAttribute('aria-label', localize('kingu.tasks.clearSearch', "Clear search"));
		this._clear.appendChild(lucideIcon('x', 16));
		const actions = append(searchRow, $('.kingu-tasks-filters-actions'));
		this._refresh = append(actions, $('button.kingu-tasks-gh-action')) as HTMLButtonElement;
		this._refresh.type = 'button';
		this._register(this._hoverService.setupDelayedHover(this._refresh, () => ({ content: this._refresh.getAttribute('aria-label') ?? '', position: { hoverPosition: HoverPosition.BELOW } })));
		this._register(addDisposableListener(this._refresh, EventType.CLICK, () => this._load(this._page)));

		this._register(addDisposableListener(this._search, EventType.INPUT, () => {
			this._preset = undefined;
			this._syncChrome();
			clearTimeout(this._debounce);
			this._debounce = setTimeout(() => this._commitSearch(), SEARCH_IDLE_MS);
		}));
		this._register(addDisposableListener(this._search, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.isComposing && !event.shiftKey) {
				event.preventDefault();
				this._commitSearch();
			}
		}));
		this._register(addDisposableListener(this._clear, EventType.CLICK, () => this._selectPreset(getDefaultPreset(this._kind))));

		// `List.tsx`: the header and rows share one horizontally scrolling grid.
		const card = append(this.element, $('.kingu-tasks-gh-card'));
		this._scroller = append(card, $('.kingu-tasks-gh-scroller'));
		this._header = append(this._scroller, $('.kingu-tasks-gh-header.kingu-tasks-gh-grid'));
		this._body = append(this._scroller, $('.kingu-tasks-gh-body'));
		this._pagination = append(card, $('.kingu-tasks-gh-pagination'));

		this._syncChrome();
		void this._load(1);
	}

	private _selectKind(kind: KinguGitHubTaskKind): void {
		this._kind = kind;
		this._selectPreset(getDefaultPreset(kind));
	}

	private _selectPreset(preset: KinguGitHubPreset): void {
		clearTimeout(this._debounce);
		this._preset = preset;
		this._query = getPresetQuery(preset);
		this._search.value = this._query;
		this._syncChrome();
		void this._load(1);
	}

	private _commitSearch(): void {
		clearTimeout(this._debounce);
		const scoped = scopeGitHubTaskSearch(this._search.value, this._kind);
		this._kind = getQueryKind(scoped, this._kind);
		this._query = scoped;
		this._search.value = scoped;
		this._syncChrome();
		void this._load(1);
	}

	private _repoUrl(): string | undefined {
		const github = this._selected.length === 1 ? this._sources ?? getRepoGitHubSlug(this._selected[0]) : undefined;
		return github ? `https://${github.host ?? 'github.com'}/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repo)}` : undefined;
	}

	/** The mode buttons, presets, picker and search placeholder: everything that tracks the query, not the rows. */
	private _syncChrome(): void {
		this._chrome.clear();
		clearNode(this._modes);
		for (const [kind, label] of [['issues', localize('kingu.tasks.github.issues', "Issues")], ['prs', localize('kingu.tasks.github.prs', "PRs")]] as const) {
			const button = append(this._modes, $('button.kingu-tasks-gh-mode')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			button.classList.toggle('active', this._kind === kind);
			button.setAttribute('aria-pressed', String(this._kind === kind));
			this._chrome.add(addDisposableListener(button, EventType.CLICK, () => this._selectKind(kind)));
		}

		clearNode(this._picker);
		const label = append(this._picker, $('span.kingu-tasks-gh-picker-label'));
		if (this._selected.length === 0) {
			append(label, $('span.muted')).textContent = localize('kingu.tasks.github.noProjects', "No projects");
		} else if (this._selected.length === this._host.repos.length && this._host.repos.length > 1) {
			label.textContent = localize('kingu.tasks.github.allProjects', "All projects");
		} else {
			this._repoBadge(label, this._selected[0]);
			if (this._selected[1]) {
				append(label, $('span.muted')).textContent = `, ${this._selected[1].displayName}`;
			}
			if (this._selected.length > 2) {
				append(label, $('span')).textContent = `+${this._selected.length - 2}`;
			}
		}
		this._picker.appendChild(lucideIcon('chevrons-up-down', 14, 'kingu-tasks-gh-picker-chevron'));

		const repoUrl = this._repoUrl();
		const github = this._selected.length === 1 ? this._sources ?? getRepoGitHubSlug(this._selected[0]) : undefined;
		this._openRepo.setAttribute('aria-label', github
			? localize('kingu.tasks.github.openRepo', "Open {0} in GitHub", `${github.owner}/${github.repo}`)
			: localize('kingu.tasks.github.openRepoNone', "Select one GitHub project to open in GitHub"));
		this._chrome.add(this._hoverService.setupDelayedHover(this._openRepo, {
			content: repoUrl && github
				? localize('kingu.tasks.github.openRepo', "Open {0} in GitHub", `${github.owner}/${github.repo}`)
				: localize('kingu.tasks.github.openRepoHint', "Select one project to open in GitHub"),
			position: { hoverPosition: HoverPosition.BELOW },
		}));

		clearNode(this._presets);
		for (const preset of getGitHubPresets(this._kind)) {
			const button = append(this._presets, $('button.kingu-tasks-gh-preset')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = preset.label;
			button.classList.toggle('active', this._preset === preset.id);
			button.setAttribute('aria-pressed', String(this._preset === preset.id));
			this._chrome.add(addDisposableListener(button, EventType.CLICK, () => this._selectPreset(preset.id)));
		}

		this._search.placeholder = this._kind === 'prs'
			? localize('kingu.tasks.github.searchPrs', "Search GitHub PRs...")
			: localize('kingu.tasks.github.searchIssues', "Search GitHub issues...");
		this._search.setAttribute('aria-label', this._search.placeholder);
		this._clear.style.display = this._search.value ? '' : 'none';

		this._refresh.disabled = this._loading;
		this._refresh.setAttribute('aria-label', this._loading
			? localize('kingu.tasks.github.refreshing', "Refreshing GitHub work")
			: localize('kingu.tasks.github.refresh', "Refresh GitHub work"));
		clearNode(this._refresh);
		this._refresh.appendChild(this._loading ? lucideIcon('loader-circle', 16, 'kingu-tasks-spin') : lucideIcon('refresh-cw', 16));

		clearNode(this._header);
		for (const column of [
			localize('kingu.tasks.github.colId', "ID"),
			localize('kingu.tasks.github.colTitle', "Title / Context"),
			localize('kingu.tasks.github.colAssignees', "Assignees"),
			localize('kingu.tasks.github.colStatus', "Status"),
			localize('kingu.tasks.github.colUpdated', "Updated"),
			'',
		]) {
			append(this._header, $('span')).textContent = column;
		}
	}

	private _repoBadge(parent: HTMLElement, repo: IKinguRepo): void {
		const badge = append(parent, $('span.kingu-tasks-gh-repo-badge'));
		const dot = append(badge, $('span.kingu-tasks-gh-repo-dot'));
		if (repo.badgeColor && /^#[0-9a-f]{3,8}$/i.test(repo.badgeColor)) {
			dot.style.backgroundColor = repo.badgeColor;
		}
		append(badge, $('span.truncate')).textContent = repo.displayName;
	}

	/** The project combobox's popover: search, "All projects" and a check row per project. */
	private _togglePicker(anchor: HTMLElement): void {
		if (this._popover.value) {
			this._popover.clear();
			return;
		}
		const store = new DisposableStore();
		this._popover.value = store;
		const popover = append(anchor, $('.kingu-tasks-gh-popover'));
		store.add({ dispose: () => popover.remove() });
		this._picker.setAttribute('aria-expanded', 'true');
		store.add({ dispose: () => this._picker.setAttribute('aria-expanded', 'false') });

		const search = append(popover, $('input.kingu-tasks-gh-popover-search')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = localize('kingu.tasks.github.searchProjects', "Search projects...");
		search.setAttribute('aria-label', search.placeholder);
		const list = append(popover, $('.kingu-tasks-gh-popover-list'));
		list.setAttribute('role', 'listbox');

		const draw = () => {
			clearNode(list);
			const query = search.value.trim().toLowerCase();
			const all = append(list, $('.kingu-tasks-gh-popover-all'));
			const allButton = append(all, $('button.kingu-tasks-gh-popover-row')) as HTMLButtonElement;
			allButton.type = 'button';
			const allSelected = this._selected.length === this._host.repos.length;
			allButton.appendChild(lucideIcon('check', 12, allSelected ? 'kingu-tasks-gh-check on' : 'kingu-tasks-gh-check'));
			append(allButton, $('span')).textContent = localize('kingu.tasks.github.allProjects', "All projects");
			store.add(addDisposableListener(allButton, EventType.CLICK, () => {
				// Clicking All while everything is picked narrows to the first project, as the ADE does.
				this._applySelection(allSelected ? this._host.repos.slice(0, 1) : [...this._host.repos], !allSelected);
				draw();
			}));
			const matches = this._host.repos.filter(repo => !query || repo.displayName.toLowerCase().includes(query) || repo.path.toLowerCase().includes(query));
			if (matches.length === 0) {
				append(list, $('.kingu-tasks-gh-popover-empty')).textContent = localize('kingu.tasks.github.noProjectMatch', "No projects match your search.");
			}
			for (const repo of matches) {
				const checked = this._selected.includes(repo);
				const row = append(list, $('button.kingu-tasks-gh-popover-row.project')) as HTMLButtonElement;
				row.type = 'button';
				row.setAttribute('role', 'option');
				row.setAttribute('aria-selected', String(checked));
				row.appendChild(lucideIcon('check', 12, checked ? 'kingu-tasks-gh-check on' : 'kingu-tasks-gh-check'));
				const text = append(row, $('span.kingu-tasks-gh-popover-text'));
				this._repoBadge(text, repo);
				const hostLabel = this._host.hostLabel(repo);
				append(text, $('span.kingu-tasks-gh-popover-path')).textContent = hostLabel ? `${hostLabel} · ${repo.path}` : repo.path;
				store.add(addDisposableListener(row, EventType.CLICK, () => {
					const next = checked ? this._selected.filter(candidate => candidate !== repo) : [...this._selected, repo];
					// Unticking the last project is a no-op: the page always has a source.
					if (next.length > 0) {
						this._applySelection(this._host.repos.filter(candidate => next.includes(candidate)), false);
						draw();
					}
				}));
			}
		};
		draw();
		store.add(addDisposableListener(search, EventType.INPUT, draw));
		const targetWindow = getWindow(anchor);
		store.add(addDisposableListener(targetWindow.document, EventType.MOUSE_DOWN, (event: MouseEvent) => {
			if (!anchor.contains(event.target as Node)) {
				this._popover.clear();
			}
		}, true));
		store.add(addDisposableListener(popover, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				this._popover.clear();
				this._picker.focus();
			}
		}));
		search.focus();
	}

	private _applySelection(repos: readonly IKinguRepo[], all: boolean): void {
		this._selected = repos;
		this._sources = undefined;
		this._host.setSelection(all ? undefined : repos.map(repo => repo.id));
		this._syncChrome();
		void this._load(1);
	}

	private async _load(page: number): Promise<void> {
		clearTimeout(this._debounce);
		const request = ++this._request;
		const repos = this._selected;
		this._page = page;
		this._loading = true;
		this._error = undefined;
		this._syncChrome();
		this._renderRows();
		if (repos.length === 0) {
			this._items = [];
			this._loading = false;
			this._syncChrome();
			this._renderRows();
			return;
		}
		const perRepo = getPerRepoLimit(repos.length);
		const query = stripRepoQualifiers(this._query.trim()) || undefined;
		try {
			const [pages, counts] = await Promise.all([
				Promise.all(repos.map(async (repo): Promise<IRepoPage> => {
					try {
						const result = await this._orca.invoke<IKinguListWorkItemsResult>('gh:listWorkItems', {
							repoPath: repo.path,
							repoId: repo.id,
							limit: perRepo,
							query,
							// The first page carries no `page`, as the ADE sends it.
							...(page > 1 ? { page } : {}),
						});
						if (repos.length === 1) {
							this._sources = (this._kind === 'prs' ? result?.sources?.prs ?? result?.sources?.issues : result?.sources?.issues ?? result?.sources?.prs) ?? undefined;
						}
						const error = result?.errors?.[this._kind === 'prs' ? 'prs' : 'issues']?.message;
						return { items: (result?.items ?? []).map(item => ({ ...item, repoId: repo.id })), error };
					} catch (error) {
						return { items: [], error: error instanceof Error ? error.message : String(error) };
					}
				})),
				Promise.all(repos.map(repo => this._orca.invoke<number>('gh:countWorkItems', { repoPath: repo.path, repoId: repo.id, query }).catch(() => undefined))),
			]);
			if (request !== this._request) {
				return;
			}
			this._items = sortWorkItemsByNumber(pages.flatMap(repoPage => repoPage.items)).slice(0, perRepo * repos.length);
			this._repoErrors = pages.flatMap((repoPage, index) => repoPage.error ? [{ repo: repos[index], message: repoPage.error }] : []);
			const total = getTotalPages(counts, perRepo);
			// Without a count, one more page is offered while the last one came back full.
			this._totalPages = total ?? (this._items.length >= perRepo ? page + 1 : page);
			if (this._repoErrors.length === repos.length) {
				this._error = undefined;
			}
		} catch (error) {
			if (request !== this._request) {
				return;
			}
			this._items = [];
			this._error = error instanceof Error && error.message ? error.message : localize('kingu.tasks.github.loadFailed', "Failed to load GitHub work.");
		}
		this._loading = false;
		this._syncChrome();
		this._renderRows();
	}

	private _renderRows(): void {
		this._rendered.clear();
		const body = this._body;
		clearNode(body);
		clearNode(this._pagination);

		if (this._error) {
			append(body, $('.kingu-tasks-credential-error')).textContent = this._error;
		}
		if (!this._loading && this._repoErrors.length > 0 && this._selected.length > 1) {
			append(body, $('.kingu-tasks-gh-warning')).textContent = localize('kingu.tasks.github.someFailed', "{0} of {1} projects failed to load", this._repoErrors.length, this._selected.length);
		}
		if (!this._loading) {
			for (const { repo, message } of this._repoErrors) {
				const github = getRepoGitHubSlug(repo);
				const name = github ? `${github.owner}/${github.repo}` : repo.displayName;
				append(body, $('.kingu-tasks-gh-warning')).textContent = this._kind === 'prs'
					? localize('kingu.tasks.github.repoPrsFailed', "Couldn't load pull requests from {0} — {1}", name, message)
					: localize('kingu.tasks.github.repoIssuesFailed', "Couldn't load issues from {0} — {1}", name, message);
			}
		}

		if (this._selected.length === 0) {
			const empty = append(body, $('.kingu-tasks-list-empty'));
			append(empty, $('p.kingu-tasks-gh-empty-title')).textContent = localize('kingu.tasks.noProjectSources', "No project sources selected");
			append(empty, $('p.kingu-tasks-list-empty-description')).textContent = localize('kingu.tasks.noProjectSourcesDescription', "Select at least one project source so Kingu knows which host/account to fetch tasks from.");
			return;
		}
		if (this._loading) {
			for (let i = 0; i < 12; i++) {
				const row = append(body, $('.kingu-tasks-gh-skeleton.kingu-tasks-gh-grid'));
				for (let cell = 0; cell < 5; cell++) {
					append(row, $('span.kingu-tasks-gh-skeleton-bar'));
				}
			}
			return;
		}
		if (this._items.length === 0 && !this._error) {
			const empty = append(body, $('.kingu-tasks-list-empty'));
			append(empty, $('p.kingu-tasks-gh-empty-title')).textContent = localize('kingu.tasks.github.empty', "No matching GitHub work");
			append(empty, $('p.kingu-tasks-list-empty-description')).textContent = localize('kingu.tasks.github.emptyDescription', "Change the query or clear it.");
			return;
		}
		const rows = append(body, $('.kingu-tasks-gh-rows'));
		for (const item of this._items) {
			this._renderRow(rows, item);
		}
		this._renderPagination();
	}

	private _renderRow(parent: HTMLElement, item: IKinguGitHubWorkItem): void {
		const row = append(parent, $('.kingu-tasks-gh-row.kingu-tasks-gh-grid'));
		const repo = this._selected.find(candidate => candidate.id === item.repoId);

		const idCell = append(row, $('.kingu-tasks-gh-cell-id'));
		const pill = append(idCell, $('span.kingu-tasks-gh-id'));
		const isPr = item.type === 'pr';
		pill.setAttribute('aria-label', isPr
			? item.state === 'draft'
				? localize('kingu.tasks.github.draftPrNumber', "Draft pull request #{0}", item.number)
				: localize('kingu.tasks.github.prNumber', "Pull request #{0}", item.number)
			: localize('kingu.tasks.github.issueNumber', "Issue #{0}", item.number));
		pill.appendChild(lucideIcon(isPr ? item.state === 'draft' ? 'git-pull-request-draft' : 'git-pull-request' : 'circle-dot', 12, isPr ? `kingu-tasks-gh-pr-icon ${item.state}` : undefined));
		append(pill, $('span.kingu-tasks-gh-number')).textContent = `#${item.number}`;

		const titleCell = append(row, $('.kingu-tasks-gh-cell-title'));
		const titleLine = append(titleCell, $('.kingu-tasks-title-line'));
		append(titleLine, $('h3.kingu-tasks-title')).textContent = item.title;
		if (repo && this._selected.length > 1) {
			const badge = append(titleLine, $('span.kingu-tasks-gh-title-repo'));
			this._repoBadge(badge, repo);
		}
		const context = append(titleCell, $('.kingu-tasks-gh-context'));
		append(context, $('span')).textContent = item.author || localize('kingu.tasks.github.unknownAuthor', "unknown author");
		if (repo && this._selected.length === 1) {
			append(context, $('span')).textContent = repo.displayName;
		}
		if (item.state === 'draft') {
			append(context, $('span')).textContent = localize('kingu.tasks.github.draftMark', "· Draft");
		}
		for (const label of item.labels.slice(0, 3)) {
			append(context, $('span.kingu-tasks-gh-label')).textContent = label;
		}

		const assignees = append(row, $('.kingu-tasks-gh-cell-assignees'));
		const people = item.assignees ?? [];
		if (people.length === 0) {
			append(assignees, $('span.kingu-tasks-gh-none')).textContent = '-';
		} else {
			const stack = append(assignees, $('.kingu-tasks-gh-avatars'));
			for (const person of people.slice(0, 3)) {
				if (person.avatarUrl) {
					const image = append(stack, $('img.kingu-tasks-avatar')) as HTMLImageElement;
					image.alt = person.name ?? person.login;
					image.referrerPolicy = 'no-referrer';
					image.src = person.avatarUrl;
				} else {
					append(stack, $('span.kingu-tasks-avatar.initial')).textContent = person.login.slice(0, 1).toUpperCase();
				}
			}
			if (people.length > 3) {
				append(stack, $('span.kingu-tasks-gh-more')).textContent = `+${people.length - 3}`;
			}
			this._rendered.add(this._hoverService.setupDelayedHover(stack, { content: people.map(person => person.login).join(', '), position: { hoverPosition: HoverPosition.BELOW } }));
		}

		const status = getWorkItemStatus(item);
		append(append(row, $('.kingu-tasks-gh-cell-status')), $(`span.kingu-tasks-gh-status.${status.tone}`)).textContent = status.label;

		const updated = append(row, $('.kingu-tasks-gh-cell-updated'));
		const updatedAt = new Date(item.updatedAt);
		updated.textContent = fromNow(updatedAt, true);
		this._rendered.add(this._hoverService.setupDelayedHover(updated, { content: updatedAt.toLocaleString(), position: { hoverPosition: HoverPosition.BELOW } }));

		const actions = append(row, $('.kingu-tasks-gh-cell-actions'));
		const open = append(actions, $('button.kingu-tasks-row-action')) as HTMLButtonElement;
		open.type = 'button';
		const openLabel = localize('kingu.tasks.github.openInBrowser', "Open in browser");
		open.setAttribute('aria-label', openLabel);
		open.appendChild(lucideIcon('external-link', 14));
		this._rendered.add(this._hoverService.setupDelayedHover(open, { content: openLabel, position: { hoverPosition: HoverPosition.BELOW } }));
		this._rendered.add(addDisposableListener(open, EventType.CLICK, () => openExternalIssue(this._openerService, item.url)));
	}

	/** `PaginationBar`: shown only when there is more than one page. */
	private _renderPagination(): void {
		const total = this._totalPages ?? 1;
		if (total <= 1) {
			return;
		}
		const nav = append(this._pagination, $('nav.kingu-tasks-gh-pager'));
		nav.setAttribute('aria-label', localize('kingu.tasks.github.pagination', "Pagination"));
		const step = (label: string, icon: string, target: number, disabled: boolean, iconFirst: boolean) => {
			const button = append(nav, $('button.kingu-tasks-gh-pager-step')) as HTMLButtonElement;
			button.type = 'button';
			button.disabled = disabled;
			if (iconFirst) {
				button.appendChild(lucideIcon(icon, 14));
			}
			append(button, $('span')).textContent = label;
			if (!iconFirst) {
				button.appendChild(lucideIcon(icon, 14));
			}
			this._rendered.add(addDisposableListener(button, EventType.CLICK, () => this._goTo(target)));
		};
		step(localize('kingu.tasks.github.previous', "Previous"), 'chevron-left', this._page - 1, this._page <= 1, true);
		for (const page of getPageNumbers(this._page, total)) {
			if (page === 'gap') {
				append(nav, $('span.kingu-tasks-gh-pager-gap')).textContent = '...';
				continue;
			}
			const button = append(nav, $('button.kingu-tasks-gh-pager-page')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = String(page);
			button.classList.toggle('current', page === this._page);
			if (page === this._page) {
				button.setAttribute('aria-current', 'page');
			}
			this._rendered.add(addDisposableListener(button, EventType.CLICK, () => this._goTo(page)));
		}
		step(localize('kingu.tasks.github.next', "Next"), 'chevron-right', this._page + 1, this._page >= total, false);
	}

	private _goTo(page: number): void {
		if (page < 1 || page === this._page) {
			return;
		}
		this._scroller.scrollTop = 0;
		void this._load(page);
	}
}
