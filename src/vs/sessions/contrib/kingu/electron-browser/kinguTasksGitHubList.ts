/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksList.css';
import './media/kinguTasksGitHub.css';
import './media/kinguTasksGitHubFilters.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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
import { applyFilterChange, parseTaskQuery } from '../common/kinguTasksGitHubQuery.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { KinguTasksGitHubFilters } from './kinguTasksGitHubFilters.js';
import { KinguTasksGitHubIssueDialog } from './kinguTasksGitHubIssueDialog.js';
import { KinguTasksGitHubProjects } from './kinguTasksGitHubProjects.js';
import { openExternalIssue } from './kinguTasksJiraList.js';
import { KinguTasksProjectPicker, renderRepoBadge } from './kinguTasksProjectPicker.js';

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
	/** The repo a project's list was read from, which for a fork can differ from its parent. */
	setSource(repoId: string, source: IKinguGitHubSlug): void;
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
	private readonly _modes: HTMLElement;
	private readonly _picker: KinguTasksProjectPicker;
	private readonly _openRepo: HTMLButtonElement;
	private readonly _presets: HTMLElement;
	private readonly _search: HTMLInputElement;
	private readonly _clear: HTMLButtonElement;
	private readonly _refresh: HTMLButtonElement;
	private readonly _newIssue: HTMLButtonElement;
	private readonly _filters: KinguTasksGitHubFilters;
	private readonly _issueDialog: KinguTasksGitHubIssueDialog;
	private readonly _repoSources = new Map<string, IKinguGitHubSlug>();
	private readonly _projects = this._register(new MutableDisposable<KinguTasksGitHubProjects>());
	private readonly _filtersCard: HTMLElement;
	private readonly _card: HTMLElement;
	private _mode: 'items' | 'project' = 'items';
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
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._register({ dispose: () => clearTimeout(this._debounce) });
		this._selected = this._host.repos.filter(repo => selectedIds.includes(repo.id));

		// `ModeControls`: Issues / PRs, the project picker and the open-in-GitHub link.
		const controls = append(this.element, $('.kingu-tasks-gh-controls'));
		this._modes = append(controls, $('.kingu-tasks-gh-modes'));
		this._picker = this._register(new KinguTasksProjectPicker({
			repos: this._host.repos,
			hostLabel: repo => this._host.hostLabel(repo),
			selected: () => this._selected,
			apply: (repos, all) => this._applySelection(repos, all),
		}));
		controls.appendChild(this._picker.element);
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
		const filters = this._filtersCard = append(this.element, $('.kingu-tasks-gh-filters'));
		this._presets = append(filters, $('.kingu-tasks-gh-presets'));
		const searchRow = append(filters, $('.kingu-tasks-gh-search-row'));
		this._filters = this._register(this._instantiationService.createInstance(KinguTasksGitHubFilters, append(searchRow, $('div')), {
			query: () => parseTaskQuery(this._query),
			kind: () => this._kind,
			authorLogins: () => [...new Set(this._items.filter(item => item.type === (this._kind === 'prs' ? 'pr' : 'issue')).map(item => item.author).filter((author): author is string => !!author))],
			primarySlug: () => this._sources ?? this._selected.map(repo => this._repoSources.get(repo.id) ?? getRepoGitHubSlug(repo)).find(slug => !!slug),
			change: change => {
				const next = applyFilterChange(scopeGitHubTaskSearch(this._search.value, this._kind), change);
				this._preset = undefined;
				this._kind = getQueryKind(next, this._kind);
				this._query = next;
				this._search.value = next;
				this._syncChrome();
				void this._load(1);
			},
		}));
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
		this._newIssue = append(actions, $('button.kingu-tasks-gh-action')) as HTMLButtonElement;
		this._newIssue.type = 'button';
		const newIssueLabel = localize('kingu.tasks.github.newIssue', "New GitHub issue");
		this._newIssue.setAttribute('aria-label', newIssueLabel);
		this._newIssue.appendChild(lucideIcon('plus', 16));
		this._register(this._hoverService.setupDelayedHover(this._newIssue, { content: newIssueLabel, position: { hoverPosition: HoverPosition.BELOW } }));
		this._issueDialog = this._register(this._instantiationService.createInstance(KinguTasksGitHubIssueDialog, {
			container: this.element,
			selectedRepos: () => this._selected,
			sourceOf: repo => this._repoSources.get(repo.id),
			created: () => void this._load(1),
		}));
		this._register(addDisposableListener(this._newIssue, EventType.CLICK, () => this._issueDialog.show()));
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
		const card = this._card = append(this.element, $('.kingu-tasks-gh-card'));
		this._scroller = append(card, $('.kingu-tasks-gh-scroller'));
		this._header = append(this._scroller, $('.kingu-tasks-gh-header.kingu-tasks-gh-grid'));
		this._body = append(this._scroller, $('.kingu-tasks-gh-body'));
		this._pagination = append(card, $('.kingu-tasks-gh-pagination'));

		this._syncChrome();
		void this._load(1);
	}

	/** The Projects mode swaps the items list for the project view, which it keeps while open. */
	private _selectProjects(): void {
		this._mode = 'project';
		if (!this._projects.value) {
			this._projects.value = this._instantiationService.createInstance(KinguTasksGitHubProjects, {
				selectedRepositories: () => this._selected.flatMap(repo => {
					const source = this._repoSources.get(repo.id) ?? getRepoGitHubSlug(repo);
					return source ? [`${source.owner}/${source.repo}`] : [];
				}),
			});
		}
		this.element.appendChild(this._projects.value.element);
		this._syncChrome();
	}

	private _selectKind(kind: KinguGitHubTaskKind): void {
		this._mode = 'items';
		this._projects.value?.element.remove();
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
		for (const [kind, label] of [['issues', localize('kingu.tasks.github.issues', "Issues")], ['prs', localize('kingu.tasks.github.prs', "PRs")], ['project', localize('kingu.tasks.github.projects', "Projects")]] as const) {
			const active = kind === 'project' ? this._mode === 'project' : this._mode === 'items' && this._kind === kind;
			const button = append(this._modes, $('button.kingu-tasks-gh-mode')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			button.classList.toggle('active', active);
			button.setAttribute('aria-pressed', String(active));
			this._chrome.add(addDisposableListener(button, EventType.CLICK, () => kind === 'project' ? this._selectProjects() : this._selectKind(kind)));
		}
		this._filtersCard.style.display = this._mode === 'project' ? 'none' : '';
		this._card.style.display = this._mode === 'project' ? 'none' : '';

		this._picker.render();

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
		this._filters?.render();
		this._newIssue.disabled = this._selected.length === 0;
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

	private _applySelection(repos: readonly IKinguRepo[], all: boolean): void {
		this._selected = repos;
		this._projects.value?.refilter();
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
						const source = (this._kind === 'prs' ? result?.sources?.prs ?? result?.sources?.issues : result?.sources?.issues ?? result?.sources?.prs) ?? undefined;
						if (source) {
							this._repoSources.set(repo.id, source);
							this._host.setSource(repo.id, source);
						}
						if (repos.length === 1) {
							this._sources = source;
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
			renderRepoBadge(badge, repo);
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
