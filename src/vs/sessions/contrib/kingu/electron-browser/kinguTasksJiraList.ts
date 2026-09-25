/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksList.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { IKinguTaskActions } from '../common/kinguTasksDetail.js';
import {
	getJiraLoadError,
	getJiraPresets,
	getJiraSortColumns,
	getJiraStatusTone,
	getSingleJiraProjectScope,
	groupJiraIssuesByStatus,
	IKinguJiraIssue,
	IKinguJiraLoadError,
	IKinguJiraStatusOrder,
	JIRA_ITEM_LIMIT,
	KinguJiraPreset,
	KinguJiraSortColumn,
	KinguSortDirection,
	nextJiraSort,
	sortJiraIssues,
} from '../common/kinguTasksJira.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { bindTaskRow } from './kinguTasksRow.js';

/** The ADE's `TASK_SEARCH_DEBOUNCE_MS`. */
const SEARCH_DEBOUNCE_MS = 300;

/** Opens an issue's page in the browser; only http(s) links from the provider are followed. */
export function openExternalIssue(openerService: IOpenerService, url: string): void {
	const uri = URI.parse(url);
	if (uri.scheme === 'https' || uri.scheme === 'http') {
		void openerService.open(uri, { openExternal: true });
	}
}

/**
 * The ADE's Jira issue list: `task-page/jira/Filters.tsx` above
 * `task-page/jira/Content.tsx` and `task-page-jira-issue-list.tsx`.
 * A row opens the issue's detail page.
 */
export class KinguTasksJiraList extends Disposable {

	readonly element: HTMLElement = $('.kingu-tasks-list-surface');

	private readonly _rendered = this._register(new DisposableStore());
	private readonly _presetButtons = new Map<KinguJiraPreset, HTMLButtonElement>();
	private readonly _refresh: HTMLButtonElement;
	private readonly _search: HTMLInputElement;
	private readonly _clear: HTMLButtonElement;
	private readonly _count: HTMLElement;
	private readonly _sortHeader: HTMLElement;
	private readonly _body: HTMLElement;

	private _preset: KinguJiraPreset = 'assigned';
	private _appliedSearch = '';
	private _issues: readonly IKinguJiraIssue[] = [];
	private _loading = false;
	private _error: IKinguJiraLoadError | undefined;
	private _errorDetailsOpen = false;
	private _sort: { orderBy: KinguJiraSortColumn; direction: KinguSortDirection } = { orderBy: 'updated', direction: 'desc' };
	private _statusOrder: IKinguJiraStatusOrder | undefined;
	private readonly _collapsed = new Set<string>();
	private _request = 0;
	private _debounce: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _siteId: string | undefined,
		private readonly _credentialError: string | undefined,
		private readonly _actions: IKinguTaskActions,
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
		this._register({ dispose: () => clearTimeout(this._debounce) });

		// `rounded-md rounded-b-none border bg-muted/50 px-3 pt-2 pb-0 shadow-sm`
		const filters = append(this.element, $('.kingu-tasks-filters'));
		const top = append(filters, $('.kingu-tasks-filters-top'));
		const presets = append(top, $('.kingu-tasks-presets'));
		for (const preset of getJiraPresets()) {
			const button = append(presets, $('button.kingu-tasks-preset')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = preset.label;
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this._search.value = '';
				this._appliedSearch = '';
				this._preset = preset.id;
				this._load();
			}));
			this._presetButtons.set(preset.id, button);
		}
		const actions = append(top, $('.kingu-tasks-filters-actions'));
		this._refresh = this._iconButton(actions, 'refresh-cw', localize('kingu.tasks.jira.refresh', "Refresh Jira issues"), () => this._load());

		const searchRow = append(filters, $('.kingu-tasks-search-row'));
		const searchBox = append(searchRow, $('.kingu-tasks-search'));
		const searchIcon = lucideIcon('search', 14, 'kingu-tasks-search-icon');
		searchBox.appendChild(searchIcon);
		this._search = append(searchBox, $('input.kingu-tasks-search-input')) as HTMLInputElement;
		this._search.type = 'text';
		this._search.spellcheck = false;
		this._search.placeholder = localize('kingu.tasks.jira.searchPlaceholder', "Jira JQL, e.g. project = ABC AND statusCategory != Done");
		this._search.setAttribute('aria-label', localize('kingu.tasks.jira.search', "Search Jira with JQL"));
		this._clear = append(searchBox, $('button.kingu-tasks-search-clear')) as HTMLButtonElement;
		this._clear.type = 'button';
		this._clear.setAttribute('aria-label', localize('kingu.tasks.clearSearch', "Clear search"));
		this._clear.appendChild(lucideIcon('x', 16));
		this._register(addDisposableListener(this._search, EventType.INPUT, () => {
			this._syncClear();
			clearTimeout(this._debounce);
			this._debounce = setTimeout(() => this._applySearch(), SEARCH_DEBOUNCE_MS);
		}));
		this._register(addDisposableListener(this._search, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.isComposing && !event.shiftKey) {
				event.preventDefault();
				this._search.value = this._search.value.trim();
				this._applySearch(true);
			}
		}));
		this._register(addDisposableListener(this._clear, EventType.CLICK, () => {
			this._search.value = '';
			this._applySearch(true);
		}));

		// `flex min-h-0 flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 bg-background shadow-sm`
		const content = append(this.element, $('.kingu-tasks-list-card'));
		const header = append(content, $('.kingu-tasks-list-header'));
		append(header, $('.kingu-tasks-list-title')).textContent = localize('kingu.tasks.jira.issues', "Jira issues");
		this._count = append(header, $('.kingu-tasks-list-count'));
		this._sortHeader = append(content, $('.kingu-tasks-sort-header.kingu-tasks-jira-grid'));
		this._body = append(content, $('.kingu-tasks-list-body'));

		this._syncClear();
		this._load();
	}

	private _iconButton(parent: HTMLElement, icon: string, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $('button.kingu-tasks-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(lucideIcon(icon, 16));
		this._register(this._hoverService.setupDelayedHover(button, { content: label, position: { hoverPosition: HoverPosition.BELOW } }));
		this._register(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	private _syncClear(): void {
		this._clear.style.display = this._search.value ? '' : 'none';
	}

	private _applySearch(force = false): void {
		clearTimeout(this._debounce);
		const next = this._search.value.trim();
		this._syncClear();
		if (force || next !== this._appliedSearch) {
			this._appliedSearch = next;
			this._load();
		}
	}

	private async _load(): Promise<void> {
		if (this._credentialError) {
			this._render();
			return;
		}
		const request = ++this._request;
		this._loading = true;
		this._error = undefined;
		this._errorDetailsOpen = false;
		this._render();
		try {
			const issues = this._appliedSearch
				? await this._orca.invoke<IKinguJiraIssue[]>('jira:searchIssues', { jql: this._appliedSearch, limit: JIRA_ITEM_LIMIT, siteId: this._siteId })
				: await this._orca.invoke<IKinguJiraIssue[]>('jira:listIssues', { filter: this._preset, limit: JIRA_ITEM_LIMIT, siteId: this._siteId });
			if (request !== this._request) {
				return;
			}
			this._issues = issues ?? [];
			this._loading = false;
			this._statusOrder = undefined;
			this._render();
			const scope = getSingleJiraProjectScope(this._issues);
			if (scope) {
				// An older engine may lack this optional metadata; the name order is the fallback.
				const order = await this._orca.invoke<IKinguJiraStatusOrder>('jira:getProjectStatusOrder', scope).catch(() => undefined);
				if (request === this._request && order) {
					this._statusOrder = order;
					this._render();
				}
			}
		} catch (error) {
			if (request !== this._request) {
				return;
			}
			this._issues = [];
			this._error = getJiraLoadError(error);
			this._loading = false;
			this._render();
		}
	}

	private _render(): void {
		this._rendered.clear();

		for (const [id, button] of this._presetButtons) {
			const active = !this._search.value && this._preset === id;
			button.classList.toggle('active', active);
			button.setAttribute('aria-pressed', String(active));
		}
		this._refresh.disabled = this._loading;
		clearNode(this._refresh);
		this._refresh.appendChild(this._loading ? lucideIcon('loader-circle', 16, 'kingu-tasks-spin') : lucideIcon('refresh-cw', 16));

		const sorted = sortJiraIssues(this._issues, this._sort.orderBy, this._sort.direction);
		this._count.textContent = localize('kingu.tasks.shownCount', "{0} shown", sorted.length);
		this._renderSortHeader();

		const body = this._body;
		clearNode(body);
		if (this._credentialError) {
			append(body, $('.kingu-tasks-credential-error')).textContent = this._credentialError;
		} else if (this._error) {
			this._renderError(body, this._error);
		}
		if (this._loading && this._issues.length === 0) {
			const skeleton = append(body, $('.kingu-tasks-skeleton'));
			for (let i = 0; i < 6; i++) {
				const row = append(skeleton, $('.kingu-tasks-skeleton-row'));
				append(row, $('.kingu-tasks-skeleton-line.primary'));
				append(row, $('.kingu-tasks-skeleton-line.secondary'));
			}
		}
		if (!this._loading && this._issues.length === 0 && !this._error && !this._credentialError) {
			const empty = append(body, $('.kingu-tasks-list-empty'));
			append(empty, $('p.kingu-tasks-list-empty-title')).textContent = localize('kingu.tasks.jira.empty', "No Jira issues found");
			append(empty, $('p.kingu-tasks-list-empty-description')).textContent = this._appliedSearch
				? localize('kingu.tasks.jira.emptySearch', "Try a different JQL query.")
				: localize('kingu.tasks.jira.emptyPreset', "No issues match the selected preset.");
		}

		const sections = groupJiraIssuesByStatus(sorted, this._statusOrder, this._sort.orderBy === 'status' ? this._sort.direction : 'asc');
		const list = append(body, $('.kingu-tasks-sections'));
		for (const section of sections) {
			const open = !this._collapsed.has(section.key);
			const group = append(list, $('.kingu-tasks-section'));
			const trigger = append(group, $('button.kingu-tasks-section-trigger')) as HTMLButtonElement;
			trigger.type = 'button';
			trigger.setAttribute('aria-expanded', String(open));
			trigger.appendChild(lucideIcon(open ? 'chevron-down' : 'chevron-right', 12, 'kingu-tasks-section-chevron'));
			append(trigger, $('span.kingu-tasks-section-label')).textContent = section.label;
			append(trigger, $('span.kingu-tasks-section-count')).textContent = String(section.issues.length);
			this._rendered.add(addDisposableListener(trigger, EventType.CLICK, () => {
				if (open) {
					this._collapsed.add(section.key);
				} else {
					this._collapsed.delete(section.key);
				}
				this._render();
			}));
			if (open) {
				const rows = append(group, $('.kingu-tasks-section-rows'));
				for (const issue of section.issues) {
					this._renderRow(rows, issue);
				}
			}
		}
	}

	private _renderSortHeader(): void {
		const header = this._sortHeader;
		clearNode(header);
		const direction = this._sort.direction === 'asc'
			? localize('kingu.tasks.sortAscending', "ascending")
			: localize('kingu.tasks.sortDescending', "descending");
		for (const column of getJiraSortColumns()) {
			const active = this._sort.orderBy === column.id;
			const button = append(header, $('button.kingu-tasks-sort-button')) as HTMLButtonElement;
			button.type = 'button';
			button.classList.toggle('wide-only', !!column.wide);
			button.setAttribute('aria-pressed', String(active));
			button.setAttribute('aria-label', active ? `${column.label}, ${direction}` : column.label);
			append(button, $('span')).textContent = column.label;
			if (active) {
				button.appendChild(lucideIcon(this._sort.direction === 'asc' ? 'arrow-up' : 'arrow-down', 12));
			}
			this._rendered.add(addDisposableListener(button, EventType.CLICK, () => {
				this._sort = nextJiraSort(this._sort, column.id);
				this._render();
			}));
		}
		append(header, $('span'));
	}

	private _renderError(body: HTMLElement, error: IKinguJiraLoadError): void {
		// `border-b border-border bg-destructive/10 px-4 py-3 text-sm text-destructive`
		const banner = append(body, $('.kingu-tasks-error'));
		banner.appendChild(lucideIcon('circle-alert', 16, 'kingu-tasks-error-icon'));
		const text = append(banner, $('.kingu-tasks-error-text'));
		append(text, $('.kingu-tasks-error-title')).textContent = error.title;
		if (error.details) {
			const toggle = append(text, $('button.kingu-tasks-error-toggle')) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.setAttribute('aria-expanded', String(this._errorDetailsOpen));
			toggle.appendChild(lucideIcon(this._errorDetailsOpen ? 'chevron-down' : 'chevron-right', 12));
			append(toggle, $('span')).textContent = localize('kingu.tasks.errorDetails', "Details");
			this._rendered.add(addDisposableListener(toggle, EventType.CLICK, () => {
				this._errorDetailsOpen = !this._errorDetailsOpen;
				this._render();
			}));
			if (this._errorDetailsOpen) {
				append(text, $('.kingu-tasks-error-details')).textContent = error.details;
			}
		}
	}

	private _renderRow(parent: HTMLElement, issue: IKinguJiraIssue): void {
		const row = append(parent, $('.kingu-tasks-row.kingu-tasks-jira-grid'));
		const noPriority = localize('kingu.tasks.noPriority', "No priority");
		const unassigned = localize('kingu.tasks.unassigned', "Unassigned");
		const tone = getJiraStatusTone(issue.status.categoryKey);
		const labels = issue.labels.slice(0, 3);
		const context = this._siteId === 'all' && issue.siteName ? `${issue.siteName} / ${issue.project.key}` : issue.project.key;

		append(row, $('span.kingu-tasks-cell-key.md-up')).textContent = issue.key;

		const main = append(row, $('.kingu-tasks-cell-main'));
		const titleLine = append(main, $('.kingu-tasks-title-line'));
		append(titleLine, $('span.kingu-tasks-key-inline.md-down')).textContent = issue.key;
		append(titleLine, $('h3.kingu-tasks-title')).textContent = issue.title;

		const compact = append(main, $('.kingu-tasks-compact-meta.md-down'));
		append(append(compact, $(`span.kingu-tasks-status.${tone}`)), $('span')).textContent = issue.status.name;
		append(compact, $('span.kingu-tasks-meta')).textContent = issue.priority?.name ?? noPriority;
		append(compact, $('span.kingu-tasks-meta.truncate')).textContent = issue.assignee?.displayName ?? unassigned;

		const labelLine = append(main, $('.kingu-tasks-label-line.lg-up'));
		append(labelLine, $('span.kingu-tasks-context.xl-down')).textContent = context;
		for (const label of labels) {
			append(labelLine, $('span.kingu-tasks-label')).textContent = label;
		}
		if (issue.labels.length > labels.length) {
			append(labelLine, $('span.kingu-tasks-label-more')).textContent = `+${issue.labels.length - labels.length}`;
		}

		append(append(append(row, $('.kingu-tasks-cell-status.md-up')), $(`span.kingu-tasks-status.${tone}`)), $('span')).textContent = issue.status.name;
		append(row, $('span.kingu-tasks-cell-muted.md-up')).textContent = issue.priority?.name ?? noPriority;

		const assignee = append(row, $('.kingu-tasks-cell-assignee.lg-up'));
		this._avatar(assignee, issue.assignee?.displayName, issue.assignee?.avatarUrl);
		append(assignee, $('span.truncate')).textContent = issue.assignee?.displayName ?? unassigned;

		const updated = append(row, $('.kingu-tasks-cell-muted.md-up'));
		const updatedAt = new Date(issue.updatedAt);
		updated.textContent = fromNow(updatedAt, true);
		this._rendered.add(this._hoverService.setupDelayedHover(updated, { content: updatedAt.toLocaleString(), position: { hoverPosition: HoverPosition.BELOW } }));

		const actions = append(row, $('.kingu-tasks-row-actions'));
		const open = append(actions, $('button.kingu-tasks-row-action')) as HTMLButtonElement;
		open.type = 'button';
		open.setAttribute('aria-label', localize('kingu.tasks.jira.openIssue', "Open {0} in Jira", issue.key));
		open.appendChild(lucideIcon('external-link', 14));
		this._rendered.add(this._hoverService.setupDelayedHover(open, { content: localize('kingu.tasks.jira.openInJira', "Open in Jira"), position: { hoverPosition: HoverPosition.BELOW } }));
		this._rendered.add(addDisposableListener(open, EventType.CLICK, () => openExternalIssue(this._openerService, issue.url)));
		bindTaskRow(row, actions, { provider: 'jira', issue }, this._actions, this._hoverService, this._rendered);
	}

	private _avatar(parent: HTMLElement, name: string | undefined, url: string | undefined): void {
		if (url) {
			const image = append(parent, $('img.kingu-tasks-avatar')) as HTMLImageElement;
			image.alt = name ?? '';
			image.referrerPolicy = 'no-referrer';
			image.src = url;
			return;
		}
		append(parent, $('span.kingu-tasks-avatar.initial')).textContent = name?.slice(0, 1) ?? '-';
	}
}
